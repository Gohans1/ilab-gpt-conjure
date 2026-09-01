import { positionPromptPopoverAtAnchor } from "./prompt-popover-position";

interface CodexQuotaWindow {
  label?: unknown;
  remaining_percent?: unknown;
  reset_at?: unknown;
  window_seconds?: unknown;
}

interface CodexQuotaCredit {
  granted_at?: unknown;
  expires_at?: unknown;
  title?: unknown;
  description?: unknown;
}

interface CodexQuotaPayload {
  available?: unknown;
  remaining_percent?: unknown;
  windows?: unknown;
  banked_resets?: unknown;
  banked_reset_credits?: unknown;
}

interface CodexQuotaPacing {
  currentPoint: number;
  remainingPercent: number;
  checkpoints: number[];
  startMilliseconds: number;
  intervalMilliseconds: number;
}

const QUOTA_REFRESH_INTERVAL_MS = 60_000;
const QUOTA_PANEL_TIME_REFRESH_INTERVAL_MS = 30_000;
const QUOTA_CHECKPOINT_COUNT = 7;
const QUOTA_MARKER_COUNT = QUOTA_CHECKPOINT_COUNT + 1;

let latestPayload: CodexQuotaPayload | null = null;
let quotaPanelOpen = false;
let quotaPanelTimer: number | null = null;

function positionQuotaPanel(root: HTMLElement, panel: HTMLElement): void {
  const anchorRect = root.getBoundingClientRect();
  positionPromptPopoverAtAnchor(
    panel,
    document.documentElement,
    anchorRect,
    {
      left: "left",
      top: "top",
      width: "width",
      maxHeight: "max-height",
    },
    {
      minWidth: 320,
      maxWidth: 430,
      maxHeight: 660,
      minVisibleHeight: 120,
    },
  );
  const panelRect = panel.getBoundingClientRect();
  if (!panelRect.width || !panelRect.height) return;
  const originX = Math.min(
    Math.max(anchorRect.left + anchorRect.width / 2 - panelRect.left, 12),
    Math.max(12, panelRect.width - 12),
  );
  const opensAbove = panelRect.bottom <= anchorRect.top;
  panel.style.setProperty("--codex-quota-panel-origin-x", `${originX}px`);
  panel.style.setProperty(
    "--codex-quota-panel-origin-y",
    `${opensAbove ? panelRect.height : 0}px`,
  );
}

export function normalizeRemainingPercent(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)));
}

function payloadRecord(payload: unknown): CodexQuotaPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  return payload as CodexQuotaPayload;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function quotaWindows(payload: CodexQuotaPayload | null): CodexQuotaWindow[] {
  if (!Array.isArray(payload?.windows)) return [];
  return payload.windows
    .map((item) => objectRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null) as CodexQuotaWindow[];
}

function quotaCredits(payload: CodexQuotaPayload | null): CodexQuotaCredit[] {
  if (!Array.isArray(payload?.banked_reset_credits)) return [];
  return payload.banked_reset_credits
    .map((item) => objectRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null) as CodexQuotaCredit[];
}

function timestampMilliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
    return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15 ? milliseconds : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function windowSeconds(window: CodexQuotaWindow): number | null {
  const value = window.window_seconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

export function buildQuotaPacing(
  window: CodexQuotaWindow,
  nowMilliseconds = Date.now(),
): CodexQuotaPacing | null {
  const resetMilliseconds = timestampMilliseconds(window.reset_at);
  const seconds = windowSeconds(window);
  if (resetMilliseconds === null || seconds === null) return null;

  const windowMilliseconds = seconds * 1000;
  if (!Number.isFinite(windowMilliseconds) || windowMilliseconds <= 0) return null;
  const startMilliseconds = resetMilliseconds - windowMilliseconds;
  const elapsedMilliseconds = Math.max(
    0,
    Math.min(windowMilliseconds, nowMilliseconds - startMilliseconds),
  );
  const intervalMilliseconds = windowMilliseconds / QUOTA_CHECKPOINT_COUNT;
  const currentPoint = Math.min(
    QUOTA_CHECKPOINT_COUNT,
    Math.floor(elapsedMilliseconds / intervalMilliseconds) + 1,
  );
  const remainingPercent = Math.round(
    Math.max(0, Math.min(100, ((resetMilliseconds - nowMilliseconds) / windowMilliseconds) * 100)),
  );
  const checkpoints = quotaCheckpointValues();

  return {
    currentPoint,
    remainingPercent,
    checkpoints,
    startMilliseconds,
    intervalMilliseconds,
  };
}

function quotaCheckpointValues(): number[] {
  return Array.from({ length: QUOTA_MARKER_COUNT }, (_, index) =>
    Number(((index * 100) / QUOTA_CHECKPOINT_COUNT).toFixed(1)),
  );
}

function formatPacingPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (totalMinutes < 1) return "<1m";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatLocalTimestamp(value: unknown): string {
  const timestamp = timestampMilliseconds(value);
  if (timestamp === null) return "—";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatLocalDate(value: unknown): string {
  const timestamp = timestampMilliseconds(value);
  if (timestamp === null) return "—";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

function formatQuotaReset(value: unknown, nowMilliseconds = Date.now()): string {
  const timestamp = timestampMilliseconds(value);
  if (timestamp === null) return "—";
  const relative = timestamp <= nowMilliseconds
    ? "now"
    : `in ${formatDuration(timestamp - nowMilliseconds)}`;
  return `${relative} (${formatLocalTimestamp(value)})`;
}

function safeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function windowSummary(windows: unknown): string {
  if (!Array.isArray(windows)) return "";
  return windows
    .map((item) => {
      const record = objectRecord(item);
      const label = safeText(record?.label);
      const percent = normalizeRemainingPercent(record?.remaining_percent);
      return label && percent !== null ? `${label}: ${percent}%` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

function appendText(parent: HTMLElement, tagName: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function displayQuotaWindowLabel(window: CodexQuotaWindow): string {
  const label = safeText(window.label) || "Quota";
  return label === "Session" && windowSeconds(window) === 5 * 60 * 60
    ? "Session · 5h"
    : label;
}

function renderQuotaWindow(window: CodexQuotaWindow, nowMilliseconds: number): HTMLElement {
  const card = document.createElement("section");
  card.className = "codex-quota-window";

  const header = document.createElement("div");
  header.className = "codex-quota-window-header";
  const label = safeText(window.label) || "Quota";
  appendText(header, "strong", "codex-quota-window-label", displayQuotaWindowLabel(window));
  const remaining = normalizeRemainingPercent(window.remaining_percent);
  appendText(header, "strong", "codex-quota-window-percent", remaining === null ? "—" : `${remaining}% left`);
  card.append(header);

  const pacing = buildQuotaPacing(window, nowMilliseconds);
  const pacingHeader = document.createElement("div");
  pacingHeader.className = "codex-quota-pacing-header";
  const pacingLabel = label === "Weekly"
    ? "Day"
    : windowSeconds(window) === 5 * 60 * 60
      ? "5h pacing"
      : "Pacing";
  appendText(pacingHeader, "span", "codex-quota-pacing-label", pacingLabel);
  appendText(
    pacingHeader,
    "span",
    "codex-quota-pacing-point",
    pacing ? `${pacing.currentPoint}/${QUOTA_CHECKPOINT_COUNT}` : "—",
  );
  card.append(pacingHeader);

  const track = document.createElement("div");
  track.className = "codex-quota-pacing-track";
  const bar = document.createElement("div");
  bar.className = "codex-quota-pacing-bar";
  const fill = document.createElement("span");
  fill.className = "codex-quota-pacing-fill";
  fill.style.width = remaining === null ? "0%" : `${remaining}%`;
  bar.append(fill);
  track.append(bar);

  const detail = document.createElement("div");
  detail.className = "codex-quota-pacing-detail";
  detail.hidden = true;
  const markerButtons: HTMLButtonElement[] = [];
  const selectMarker = (button: HTMLButtonElement, text: string): void => {
    markerButtons.forEach((item) => {
      item.classList.toggle("is-selected", item === button);
      item.setAttribute("aria-pressed", String(item === button));
    });
    detail.textContent = text;
    detail.hidden = false;
  };

  if (pacing) {
    const nowMarker = document.createElement("button");
    nowMarker.type = "button";
    nowMarker.className = "codex-quota-pacing-now";
    nowMarker.style.left = `${pacing.remainingPercent}%`;
    const nowText = `Now ${formatPacingPercent(pacing.remainingPercent)}% · ${formatLocalTimestamp(nowMilliseconds)}`;
    nowMarker.title = nowText;
    nowMarker.setAttribute("aria-label", nowText);
    nowMarker.setAttribute("aria-pressed", "false");
    markerButtons.push(nowMarker);
    nowMarker.addEventListener("click", () => selectMarker(nowMarker, nowText));
    track.append(nowMarker);
  }

  const checkpoints = pacing?.checkpoints || quotaCheckpointValues();
  checkpoints.forEach((checkpoint, index) => {
    const markerPoint = QUOTA_MARKER_COUNT - index;
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "codex-quota-pacing-marker";
    if (pacing && markerPoint === pacing.currentPoint) marker.classList.add("is-current");
    marker.style.left = `${checkpoint}%`;
    const checkpointMilliseconds = pacing
      ? pacing.startMilliseconds + (markerPoint - 1) * pacing.intervalMilliseconds
      : null;
    const checkpointText = `${formatPacingPercent(checkpoint)}% · ${checkpointMilliseconds === null ? "—" : formatLocalTimestamp(checkpointMilliseconds)}`;
    marker.title = checkpointText;
    marker.setAttribute("aria-label", `${checkpointText} checkpoint`);
    marker.setAttribute("aria-pressed", "false");
    markerButtons.push(marker);
    marker.addEventListener("click", () => selectMarker(marker, checkpointText));
    track.append(marker);
  });
  card.append(track, detail);

  const resetRow = document.createElement("div");
  resetRow.className = "codex-quota-window-reset";
  const resetText = formatQuotaReset(window.reset_at, nowMilliseconds);
  appendText(
    resetRow,
    "span",
    "codex-quota-window-reset-value",
    resetText === "—" ? "—" : `reset ${resetText}`,
  );
  card.append(resetRow);
  return card;
}

function renderQuotaResetBank(payload: CodexQuotaPayload | null): void {
  const countElement = document.getElementById("codexQuotaResetBankCount");
  const listElement = document.getElementById("codexQuotaResetBankList");
  if (!countElement || !listElement) return;

  const count = payload?.banked_resets;
  const normalizedCount = typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count
    : null;
  countElement.textContent = normalizedCount === null ? "—" : String(normalizedCount);
  listElement.replaceChildren();

  const credits = quotaCredits(payload);
  if (!credits.length) {
    appendText(
      listElement,
      "span",
      "codex-quota-reset-bank-empty",
      normalizedCount === null
        ? "Reset bank unavailable"
        : normalizedCount === 0
          ? "No banked reset"
          : "Reset details unavailable",
    );
    return;
  }

  credits.forEach((credit) => {
    const row = document.createElement("div");
    row.className = "codex-quota-reset-credit";
    appendText(row, "strong", "codex-quota-reset-credit-title", safeText(credit.title) || "Banked reset");
    appendText(
      row,
      "span",
      "codex-quota-reset-credit-dates",
      `${formatLocalDate(credit.granted_at)} → ${formatLocalDate(credit.expires_at)}`,
    );
    listElement.append(row);
  });
}

function renderCodexQuotaPanel(payload: CodexQuotaPayload | null): void {
  const statusElement = document.getElementById("codexQuotaPanelStatus");
  const windowsElement = document.getElementById("codexQuotaWindows");
  if (!statusElement || !windowsElement) return;

  const nowMilliseconds = Date.now();
  const windows = payload?.available === true ? quotaWindows(payload) : [];
  statusElement.hidden = windows.length > 0;
  statusElement.textContent = windows.length ? "" : "Quota unavailable";
  windowsElement.replaceChildren();
  windows.forEach((window) => windowsElement.append(renderQuotaWindow(window, nowMilliseconds)));
  renderQuotaResetBank(payload);
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
  latestPayload = record;
  const percent = record?.available === true
    ? normalizeRemainingPercent(record.remaining_percent)
    : null;
  if (percent === null) {
    renderUnavailable(root, fill, value);
    renderCodexQuotaPanel(record);
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
  renderCodexQuotaPanel(record);
}

function setQuotaPanelOpen(open: boolean): void {
  const root = document.getElementById("codexQuota");
  const panel = document.getElementById("codexQuotaPanel");
  if (!root || !panel) return;

  quotaPanelOpen = open;
  panel.hidden = !open;
  panel.classList.toggle("hidden", !open);
  panel.setAttribute("aria-hidden", String(!open));
  root.setAttribute("aria-expanded", String(open));
  if (open) {
    renderCodexQuotaPanel(latestPayload);
    positionQuotaPanel(root, panel);
    if (quotaPanelTimer === null) {
      quotaPanelTimer = window.setInterval(() => renderCodexQuotaPanel(latestPayload), QUOTA_PANEL_TIME_REFRESH_INTERVAL_MS);
    }
  } else if (quotaPanelTimer !== null) {
    window.clearInterval(quotaPanelTimer);
    quotaPanelTimer = null;
  }
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
  if (!root || root.dataset.initialized === "true") return;
  root.dataset.initialized = "true";

  const panel = document.getElementById("codexQuotaPanel");
  const closeButton = document.getElementById("codexQuotaPanelClose");
  const repositionPanel = () => {
    if (quotaPanelOpen && panel) positionQuotaPanel(root, panel);
  };
  root.addEventListener("click", () => setQuotaPanelOpen(!quotaPanelOpen));
  closeButton?.addEventListener("click", () => {
    setQuotaPanelOpen(false);
    root.focus();
  });
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node) || !quotaPanelOpen || !panel) return;
    if (!root.contains(target) && !panel.contains(target)) setQuotaPanelOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && quotaPanelOpen) {
      setQuotaPanelOpen(false);
      root.focus();
    }
  });
  window.addEventListener("resize", repositionPanel);
  window.addEventListener("scroll", repositionPanel, true);

  void refreshCodexQuota(root);
  window.setInterval(() => {
    void refreshCodexQuota(root);
  }, QUOTA_REFRESH_INTERVAL_MS);
}
