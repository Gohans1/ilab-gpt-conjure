from __future__ import annotations

import unittest
from pathlib import Path


class WebUIStaticCodexQuotaTests(unittest.TestCase):
    def test_quota_mount_is_immediately_before_provider_control(self) -> None:
        html = Path("codex_image/webui/static/index.html").read_text(encoding="utf-8")
        quota_index = html.index('id="codexQuota"')
        provider_index = html.index('<div class="generation-provider-control">')

        self.assertLess(quota_index, provider_index)
        self.assertIn('class="codex-quota"', html)
        self.assertIn('id="codexQuotaFill"', html)
        self.assertIn('id="codexQuotaValue"', html)

    def test_main_initializes_quota_feature(self) -> None:
        source = Path("codex_image/webui/frontend/src/main.ts").read_text(encoding="utf-8")

        self.assertIn('import { initCodexQuotaFeature } from "./codex-quota";', source)
        self.assertIn("initCodexQuotaFeature();", source)

    def test_quota_percent_normalization_keeps_unknown_as_null(self) -> None:
        module_path = Path("codex_image/webui/frontend/src/codex-quota.ts")
        source = module_path.read_text(encoding="utf-8")
        self.assertIn("export function normalizeRemainingPercent", source)
        self.assertIn("if (value == null)", source)
        self.assertIn("return null", source)
        self.assertIn("Math.max(0, Math.min(100", source)

    def test_quota_styles_keep_the_mount_in_the_provider_row(self) -> None:
        styles = Path(
            "codex_image/webui/static/styles/30-layout-top-nav-panels.css"
        ).read_text(encoding="utf-8")

        self.assertIn(".codex-quota", styles)
        self.assertIn("order: 1", styles[styles.index(".codex-quota"):])

    def test_quota_assets_bust_old_cache_and_show_loading_track(self) -> None:
        index = Path("codex_image/webui/static/index.html").read_text(encoding="utf-8")
        history = Path("codex_image/webui/static/history.html").read_text(encoding="utf-8")
        service_worker = Path("codex_image/webui/static/service-worker.js").read_text(encoding="utf-8")
        styles = Path(
            "codex_image/webui/static/styles/30-layout-top-nav-panels.css"
        ).read_text(encoding="utf-8")

        self.assertIn("styles.css?v=runtime-777", index)
        self.assertIn("app.js?v=runtime-777", index)
        self.assertIn("styles.css?v=runtime-777", history)
        self.assertIn("styles.css?v=runtime-777", service_worker)
        self.assertIn("app.js?v=runtime-777", service_worker)
        self.assertIn(".codex-quota[data-state=\"loading\"] .codex-quota-track::before", styles)
        self.assertIn("flex: 0 0 140px", styles)

    def test_quota_fill_respects_reduced_motion(self) -> None:
        styles = Path(
            "codex_image/webui/static/styles/30-layout-top-nav-panels.css"
        ).read_text(encoding="utf-8")

        self.assertRegex(
            styles,
            r"@media \(prefers-reduced-motion: reduce\)[\s\S]*\.codex-quota-fill[\s\S]*transition:\s*none",
        )


if __name__ == "__main__":
    unittest.main()
