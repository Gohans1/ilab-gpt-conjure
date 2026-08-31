interface CodexQuotaWindow {
  label?: unknown;
  remaining_percent?: unknown;
}

interface CodexQuotaPayload {
  available?: unknown;
  remaining_percent?: unknown;
  windows?: unknown;
}

const QUOTA_REFRESH_INTERVAL_MS = 60_000;

export function normalizeRemainingPercent(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function payloadRecord(payload: unknown): CodexQuotaPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  return payload as CodexQuotaPayload;
}

function windowSummary(windows: unknown): string {
  if (!Array.isArray(windows)) return "";
  return windows
    .map((item: CodexQuotaWindow) => {
      const label = typeof item?.label === "string" ? item.label : "";
      const percent = normalizeRemainingPercent(item?.remaining_percent);
      return label && percent !== null ? `${label}: ${percent}%` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

function renderUnavailable(root: HTMLElement, fill: HTMLElement, value: HTMLElement): void {
  root.dataset.state = "unavailable";
  root.dataset.available = "false";
  root.setAttribute("aria-busy", "false");
  root.setAttribute("aria-label", "Codex quota unavailable");
  root.title = "Codex quota unavailable";
  fill.style.width = "0%";
  value.textContent = "—";
}

export function renderCodexQuota(payload: unknown): void {
  const root = document.getElementById("codexQuota");
  const fill = document.getElementById("codexQuotaFill");
  const value = document.getElementById("codexQuotaValue");
  if (!root || !fill || !value) return;

  const record = payloadRecord(payload);
  const percent = record?.available === true
    ? normalizeRemainingPercent(record.remaining_percent)
    : null;
  if (percent === null) {
    renderUnavailable(root, fill, value);
    return;
  }

  const details = windowSummary(record?.windows);
  root.dataset.state = "available";
  root.dataset.available = "true";
  root.setAttribute("aria-busy", "false");
  root.setAttribute(
    "aria-label",
    details ? `Codex quota: ${percent}% remaining. ${details}` : `Codex quota: ${percent}% remaining`,
  );
  root.title = root.getAttribute("aria-label") || "Codex quota";
  fill.style.width = `${percent}%`;
  value.textContent = `${percent}%`;
}

async function refreshCodexQuota(root: HTMLElement): Promise<void> {
  if (root.dataset.loading === "true") return;
  root.dataset.loading = "true";
  root.dataset.state = "loading";
  root.setAttribute("aria-busy", "true");
  try {
    const response = await fetch("/api/codex/quota", {
      headers: { Accept: "application/json" },
    });
    const payload: unknown = await response.json();
    if (!response.ok) throw new Error("Quota request failed");
    renderCodexQuota(payload);
  } catch {
    renderCodexQuota({ available: false });
  } finally {
    root.dataset.loading = "false";
  }
}

export function initCodexQuotaFeature(): void {
  const root = document.getElementById("codexQuota");
  if (!root) return;
  void refreshCodexQuota(root);
  window.setInterval(() => {
    void refreshCodexQuota(root);
  }, QUOTA_REFRESH_INTERVAL_MS);
}
