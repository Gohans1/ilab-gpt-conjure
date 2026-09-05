from __future__ import annotations

from collections import deque
from threading import Condition
from typing import Any

from codex_image.client import ImageResult
from codex_image.generation.service import GenerationService
from codex_image.generation.types import GeneratedAsset, GenerationResult
from codex_image.providers.contracts import ExecutionPlan
from codex_image.providers.registry import ProviderRegistry, default_registry


class _LegacyClientAdapter:
    def __init__(self, client: Any) -> None:
        self.client = client

    def execute(self, plan: ExecutionPlan) -> GenerationResult:
        command = plan.command
        params = {**command.parameters, **command.legacy_compat_parameters}
        count = max(1, int(params.get("output.count") or 1))
        common: dict[str, Any] = {
            "prompt": command.prompt,
            "main_model": command.main_model,
            "model": plan.binding.remote_model_id,
            "size": params.get("canvas.size"),
            "quality": params.get("gpt.quality"),
            "background": params.get("gpt.background"),
            "output_format": params.get("output.format", "png"),
            "moderation": params.get("gpt.moderation"),
            "output_compression": params.get("gpt.output_compression"),
        }
        ephemeral_reference_files: list[Any] = []
        if plan.binding.protocol_profile.endswith("responses"):
            common["instructions"] = command.instructions
            common["web_search"] = bool(params.get("gpt.web_search"))
            ephemeral_reference_files = list(command.reference_files)
            common["reference_files"] = ephemeral_reference_files
        # Determine if this client is a batch-capable bridge (e.g. ChatGPT Web bridge)
        # Standard OpenAI API clients generate images per-slot to preserve concurrency and per-image progress.
        base_url = str(getattr(self.client, "base_url", "")).lower()
        is_batch_bridge = (
            getattr(self.client, "supports_batch_generation", False)
            or ":3000" in base_url
            or "127.0.0.1:3000" in base_url
            or "localhost:3000" in base_url
            or "bridge" in base_url
        )

        try:
            if command.operation == "edit":
                if is_batch_bridge and count > 1 and hasattr(self.client, "edit_images"):
                    results = self.client.edit_images(
                        **common,
                        n=count,
                        images=[image.data_url for image in command.image_inputs],
                        mask_image=command.mask_image,
                        input_fidelity=params.get("gpt.input_fidelity"),
                    )
                else:
                    results = [
                        self.client.edit_image(
                            **common,
                            images=[image.data_url for image in command.image_inputs],
                            mask_image=command.mask_image,
                            input_fidelity=params.get("gpt.input_fidelity"),
                        )
                    ]
            else:
                if is_batch_bridge and count > 1 and hasattr(self.client, "generate_images"):
                    results = self.client.generate_images(
                        **common,
                        n=count,
                        reference_images=[image.data_url for image in command.image_inputs],
                    )
                else:
                    results = [
                        self.client.generate_image(
                            **common,
                            reference_images=[image.data_url for image in command.image_inputs],
                        )
                    ]
        finally:
            ephemeral_reference_files.clear()

        def _mime_type_for_format(fmt: str | None) -> str:
            raw = str(fmt or "png").lower().strip().lstrip(".")
            return "image/jpeg" if raw in {"jpg", "jpeg"} else f"image/{raw}"

        assets = tuple(
            GeneratedAsset(
                image_bytes=result.image_bytes,
                mime_type=_mime_type_for_format(result.output_format),
                revised_prompt=result.revised_prompt,
                metadata={
                    "size": result.size,
                    "background": result.background,
                    "quality": result.quality,
                    "tool_usage": result.tool_usage,
                },
            )
            for result in results
        )
        usage = dict(results[0].usage) if results else {}
        return GenerationResult(
            assets=assets,
            usage=usage,
        )


class ExecutionPlanImageClient:
    """Compatibility-shaped executor backed by the reviewed GenerationService path."""

    def __init__(
        self,
        plan: ExecutionPlan,
        client: Any,
        *,
        registry: ProviderRegistry | None = None,
    ) -> None:
        self._plan = plan
        self._uses_legacy_client_adapter = plan.binding.parameter_codec.startswith("gpt_")
        if self._uses_legacy_client_adapter:
            base_registry = registry or default_registry()
            registry = ProviderRegistry(
                protocols={
                    plan.binding.protocol_profile: _LegacyClientAdapter(client)
                },
                codecs={
                    plan.binding.parameter_codec: base_registry.codec(
                        plan.binding.parameter_codec
                    )
                },
            )
        elif registry is None:
            registry = default_registry()
        self._registry = registry
        self._service = GenerationService(None, registry)  # resolver is not used for a frozen plan
        self._condition = Condition()
        self._pending_results: deque[ImageResult] = deque()
        self._request_in_flight = False
        self._failure: Exception | None = None
        self._failure_remaining = 0
        try:
            self._expected_outputs = max(
                1, int(plan.command.parameters.get("output.count") or 1)
            )
        except (TypeError, ValueError):
            self._expected_outputs = 1
        self.direct_images_concurrent = (
            plan.provider.id != "codex"
            or plan.binding.protocol_profile.endswith("images")
        )

    def generate_image(self, **kwargs: Any) -> ImageResult:
        return self._execute("generate", kwargs)

    def edit_image(self, **kwargs: Any) -> ImageResult:
        return self._execute("edit", kwargs)

    def _execute(self, operation: str, kwargs: dict[str, Any]) -> ImageResult:
        if operation != self._plan.command.operation:
            raise RuntimeError("Execution operation differs from the frozen generation plan.")
        if self._uses_legacy_client_adapter:
            with self._condition:
                if self._pending_results:
                    return self._pending_results.popleft()
            result = self._service.execute_plan_once(self._plan)
            if not result.assets:
                raise RuntimeError("The provider returned no image asset.")
            converted = [
                self._image_result(result, asset, kwargs) for asset in result.assets
            ]
            with self._condition:
                self._pending_results.extend(converted[1:])
                return converted[0]
        # The executor kwargs are legacy compatibility plumbing. The restored
        # snapshot plan is authoritative for all request choices and inputs.
        while True:
            with self._condition:
                if self._pending_results:
                    return self._pending_results.popleft()
                if self._failure is not None:
                    if self._failure_remaining > 0:
                        failure = self._failure
                        self._failure_remaining -= 1
                        if self._failure_remaining == 0:
                            self._failure = None
                        raise failure
                    else:
                        self._failure = None
                if not self._request_in_flight:
                    self._request_in_flight = True
                    break
                self._condition.wait(timeout=1.0)

        try:
            result = self._service.execute_plan_once(self._plan)
            if not result.assets:
                raise RuntimeError("The provider returned no image asset.")
            converted = [
                self._image_result(result, asset, kwargs) for asset in result.assets
            ]
        except BaseException as exc:
            with self._condition:
                self._request_in_flight = False
                self._failure = exc if isinstance(exc, Exception) else RuntimeError(str(exc))
                self._failure_remaining = max(0, self._expected_outputs - 1)
                self._condition.notify_all()
            raise

        with self._condition:
            self._pending_results.extend(converted)
            self._request_in_flight = False
            image_result = self._pending_results.popleft()
            self._condition.notify_all()
            return image_result

    @staticmethod
    def _image_result(
        result: GenerationResult,
        asset: GeneratedAsset,
        kwargs: dict[str, Any],
    ) -> ImageResult:
        metadata = dict(asset.metadata)
        mime_type = str(asset.mime_type or "").split(";", 1)[0].strip().lower()
        asset_format = mime_type.split("/", 1)[1] if mime_type.startswith("image/") else ""
        if asset_format == "jpg":
            asset_format = "jpeg"
        output_format = str(
            asset_format
            or metadata.get("output_format")
            or metadata.get("format")
            or kwargs.get("output_format")
            or "png"
        )
        size = str(metadata.get("size") or kwargs.get("size") or "")
        if not size and asset.width is not None and asset.height is not None:
            size = f"{asset.width}x{asset.height}"
        tool_usage = dict(metadata.get("tool_usage") or {})
        if result.text_parts:
            tool_usage["text_parts"] = list(result.text_parts)
        if result.provider_metadata:
            tool_usage["provider_metadata"] = dict(result.provider_metadata)
        return ImageResult(
            asset.image_bytes,
            asset.revised_prompt,
            output_format,
            size,
            str(metadata.get("background") or kwargs.get("background") or "auto"),
            str(metadata.get("quality") or kwargs.get("quality") or "auto"),
            dict(result.usage),
            tool_usage,
        )


__all__ = ("ExecutionPlanImageClient",)
