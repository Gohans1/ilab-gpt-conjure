import { formatTranslation, LOCALE_CHANGE_EVENT, translate } from "./i18n";
import { getLegacyBridge } from "./state";

type NetworkEgressMode = "system" | "direct" | "custom";

interface NetworkEgressPayload {
  settings: {
    mode: NetworkEgressMode;
    custom_proxy_url: string;
  };
  resolved: {
    mode: NetworkEgressMode;
    route: "system" | "direct" | "proxy";
  };
  restart_required: false;
}

let networkEgressFeatureInitialized = false;
let currentNetworkEgress: NetworkEgressPayload | null = null;

function normalizedMode(value: unknown): NetworkEgressMode {
  return value === "direct" || value === "custom" ? value : "system";
}

function modeTranslationKey(mode: NetworkEgressMode): string {
  return `networkEgress.${mode}`;
}

function setNetworkEgressFeedback(message: string, type = ""): void {
  const { els } = getLegacyBridge();
  if (!els.networkEgressStatus) return;
  els.networkEgressStatus.textContent = message;
  els.networkEgressStatus.classList.toggle("ok", type === "ok");
  els.networkEgressStatus.classList.toggle("error", type === "error");
  els.networkEgressStatus.classList.toggle("running", type === "running");
}

function selectedNetworkEgressMode(): NetworkEgressMode {
  const { els } = getLegacyBridge();
  return normalizedMode(els.networkEgressMode?.value);
}

function renderNetworkEgressMode(mode: NetworkEgressMode): void {
  const { els } = getLegacyBridge();
  if (els.networkEgressMode) els.networkEgressMode.value = mode;
  const buttons = Array.from(
    els.systemSettingsNetworkPanel?.querySelectorAll("[data-network-egress-mode]") || [],
  );
  buttons.forEach((button: any) => {
    const active = button.dataset.networkEgressMode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (els.networkEgressCustomProxyField) {
    els.networkEgressCustomProxyField.hidden = mode !== "custom";
  }
}

function renderNetworkEgress(payload: NetworkEgressPayload): void {
  const { els } = getLegacyBridge();
  currentNetworkEgress = payload;
  const mode = normalizedMode(payload.settings?.mode);
  renderNetworkEgressMode(mode);
  if (els.networkEgressCustomProxy) {
    els.networkEgressCustomProxy.value = payload.settings?.custom_proxy_url || "";
  }
  if (els.networkEgressCurrentRoute) {
    const resolvedMode = normalizedMode(payload.resolved?.mode);
    els.networkEgressCurrentRoute.textContent = formatTranslation(
      "networkEgress.currentRoute",
      { route: translate(modeTranslationKey(resolvedMode)) },
    );
  }
}

function networkEgressFormPayload(): {
  mode: NetworkEgressMode;
  custom_proxy_url: string;
} {
  const { els } = getLegacyBridge();
  return {
    mode: selectedNetworkEgressMode(),
    custom_proxy_url: String(els.networkEgressCustomProxy?.value || "").trim(),
  };
}

function networkEgressPayloadIsValid(
  payload: ReturnType<typeof networkEgressFormPayload>,
): boolean {
  if (payload.mode !== "custom") return true;
  try {
    const url = new URL(payload.custom_proxy_url);
    return (
      (url.protocol === "http:" || url.protocol === "https:")
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && (url.pathname === "" || url.pathname === "/")
      && !url.search
      && !url.hash
    );
  } catch {
    return false;
  }
}

async function refreshNetworkEgress(): Promise<void> {
  try {
    const response = await fetch("/api/network-egress");
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || translate("networkEgress.loadFailed"));
    renderNetworkEgress(data);
    setNetworkEgressFeedback("", "");
  } catch (error: any) {
    setNetworkEgressFeedback(
      error.message || translate("networkEgress.loadFailed"),
      "error",
    );
  }
}

async function saveNetworkEgress(): Promise<void> {
  const { els } = getLegacyBridge();
  if (!els.saveNetworkEgressButton) return;
  const payload = networkEgressFormPayload();
  if (!networkEgressPayloadIsValid(payload)) {
    setNetworkEgressFeedback(translate("networkEgress.saveFailed"), "error");
    return;
  }
  els.saveNetworkEgressButton.disabled = true;
  try {
    const response = await fetch("/api/network-egress", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || translate("networkEgress.saveFailed"));
    renderNetworkEgress(data);
    setNetworkEgressFeedback(translate("networkEgress.saved"), "ok");
  } catch (error: any) {
    setNetworkEgressFeedback(
      error.message || translate("networkEgress.saveFailed"),
      "error",
    );
  } finally {
    els.saveNetworkEgressButton.disabled = false;
  }
}

async function testNetworkEgress(): Promise<void> {
  const { els } = getLegacyBridge();
  if (!els.testNetworkEgressButton) return;
  const payload = networkEgressFormPayload();
  if (!networkEgressPayloadIsValid(payload)) {
    setNetworkEgressFeedback(translate("networkEgress.testFailed"), "error");
    return;
  }
  els.testNetworkEgressButton.disabled = true;
  setNetworkEgressFeedback(translate("networkEgress.test"), "running");
  try {
    const response = await fetch("/api/network-egress/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.detail || data.error || translate("networkEgress.testFailed"));
    }
    setNetworkEgressFeedback(
      formatTranslation("networkEgress.testSucceeded", {
        target: data.target,
        elapsed: data.elapsed_ms,
      }),
      "ok",
    );
  } catch (error: any) {
    setNetworkEgressFeedback(
      error.message || translate("networkEgress.testFailed"),
      "error",
    );
  } finally {
    els.testNetworkEgressButton.disabled = false;
  }
}

function handleNetworkEgressModeClick(event: Event): void {
  const target = event.target as HTMLElement | null;
  const button = target?.closest?.("[data-network-egress-mode]") as HTMLElement | null;
  if (!button) return;
  renderNetworkEgressMode(normalizedMode(button.dataset.networkEgressMode));
  setNetworkEgressFeedback("", "");
}

export function initNetworkEgressSettingsFeature(): void {
  if (networkEgressFeatureInitialized) return;
  networkEgressFeatureInitialized = true;
  const { els } = getLegacyBridge();
  els.systemSettingsNetworkPanel?.addEventListener(
    "click",
    handleNetworkEgressModeClick,
  );
  els.testNetworkEgressButton?.addEventListener("click", testNetworkEgress);
  els.saveNetworkEgressButton?.addEventListener("click", saveNetworkEgress);
  document.addEventListener(LOCALE_CHANGE_EVENT, () => {
    if (currentNetworkEgress) renderNetworkEgress(currentNetworkEgress);
  });
  Object.assign(getLegacyBridge().methods, {
    refreshNetworkEgress,
    saveNetworkEgress,
    testNetworkEgress,
  });
}
