import { translate } from "./i18n";
import { escapeHtml } from "./webui-utils";

export const LIGHTBOX_FIT_SCALE = 1;
export const LIGHTBOX_MIN_SCALE = 0.1;
export const LIGHTBOX_MAX_SCALE = 5;
export const LIGHTBOX_ZOOM_STEP = 0.25;
const LIGHTBOX_FIT_SNAP_EPSILON = 0.025;
const LIGHTBOX_SHORTCUT_HINT_DURATION_MS = 3200;

export type LightboxTaskDirection = "previous" | "next";
export type LightboxTaskNavigationContext = {
  taskId: string;
  imageIndex: number;
};
export type LightboxTaskNavigation = (
  direction: LightboxTaskDirection,
  context: LightboxTaskNavigationContext,
) => void | Promise<void>;
export type LightboxAction =
  | "previous-image"
  | "next-image"
  | "previous-task"
  | "next-task"
  | "zoom-in"
  | "zoom-out"
  | "fit"
  | "actual-size";

type LightboxZoomBindings = {
  zoomIn: () => void;
  zoomOut: () => void;
  fit: () => void;
  actualSize: () => void;
};

const lightboxShortcutHintTimers = new WeakMap<HTMLElement, number>();

export function isLightboxFitScale(scale: number): boolean {
  return Math.abs(Number(scale) - LIGHTBOX_FIT_SCALE) <= LIGHTBOX_FIT_SNAP_EPSILON;
}

export function isLightboxAtOrBelowFitScale(scale: number): boolean {
  const numericScale = Number(scale);
  if (!Number.isFinite(numericScale)) return true;
  return numericScale <= LIGHTBOX_FIT_SCALE + LIGHTBOX_FIT_SNAP_EPSILON;
}

export function normalizeLightboxScale(scale: number): number {
  if (!Number.isFinite(scale)) return LIGHTBOX_FIT_SCALE;
  const clamped = Math.min(Math.max(scale, LIGHTBOX_MIN_SCALE), LIGHTBOX_MAX_SCALE);
  if (isLightboxFitScale(clamped)) return LIGHTBOX_FIT_SCALE;
  return Math.round(clamped * 1000) / 1000;
}

export function lightboxScaleFromWheel(scale: number, deltaY: number): number {
  return normalizeLightboxScale(scale + Number(deltaY || 0) * -0.005);
}

export function lightboxSteppedScale(scale: number, direction: "in" | "out"): number {
  return normalizeLightboxScale(scale + (direction === "in" ? LIGHTBOX_ZOOM_STEP : -LIGHTBOX_ZOOM_STEP));
}

export function lightboxActualSizeScale(
  naturalWidth: number,
  naturalHeight: number,
  fittedWidth: number,
  fittedHeight: number,
): number {
  const widthScale = Number(naturalWidth) / Math.max(1, Number(fittedWidth));
  const heightScale = Number(naturalHeight) / Math.max(1, Number(fittedHeight));
  const scale = Math.max(widthScale || 0, heightScale || 0);
  return normalizeLightboxScale(scale > 0 ? scale : LIGHTBOX_FIT_SCALE);
}

export function lightboxDisplayPercent(scale: number, actualSizeScale: number): number {
  const actual = Math.max(LIGHTBOX_MIN_SCALE, Number(actualSizeScale) || LIGHTBOX_FIT_SCALE);
  return Math.max(1, Math.round((normalizeLightboxScale(scale) / actual) * 100));
}

export function lightboxActionForKey(key: string): LightboxAction | null {
  if (key === "ArrowLeft") return "previous-image";
  if (key === "ArrowRight") return "next-image";
  if (key === "ArrowUp" || key === "PageUp") return "previous-task";
  if (key === "ArrowDown" || key === "PageDown") return "next-task";
  if (key === "+" || key === "=") return "zoom-in";
  if (key === "-") return "zoom-out";
  if (key === "0") return "fit";
  if (key === "1") return "actual-size";
  return null;
}

export function shouldCloseLightboxFromClick(
  target: EventTarget | null,
  root: HTMLElement,
): boolean {
  if (target === root) return true;
  const candidate = target as (EventTarget & { closest?: (selectors: string) => Element | null }) | null;
  if (typeof candidate?.closest !== "function") return false;
  return !candidate.closest("img, button, [data-lightbox-zoom-toolbar]");
}

export function lightboxZoomChromeHtml(): string {
  const zoomControls = escapeHtml(translate("lightbox.zoomControls"));
  const zoomOut = escapeHtml(translate("lightbox.zoomOut"));
  const zoomIn = escapeHtml(translate("lightbox.zoomIn"));
  const fit = escapeHtml(translate("lightbox.fit"));
  const fitPage = escapeHtml(translate("lightbox.fitPage"));
  const actualSize = escapeHtml(translate("lightbox.actualSize"));
  const shortcuts = escapeHtml(translate("lightbox.shortcuts"));
  const switchImage = escapeHtml(translate("lightbox.switchImage"));
  const switchTask = escapeHtml(translate("lightbox.switchTask"));
  const wheelZoom = escapeHtml(translate("lightbox.wheelZoom"));
  return `
    <div class="lightbox-zoom-toolbar" data-lightbox-zoom-toolbar role="toolbar" aria-label="${zoomControls}">
      <button type="button" class="lightbox-zoom-button" data-lightbox-zoom-out aria-label="${zoomOut}" title="${zoomOut}" aria-keyshortcuts="-">−</button>
      <output class="lightbox-zoom-value" data-lightbox-zoom-value aria-label="${zoomControls}">100%</output>
      <button type="button" class="lightbox-zoom-button" data-lightbox-zoom-in aria-label="${zoomIn}" title="${zoomIn}" aria-keyshortcuts="+">+</button>
      <span class="lightbox-zoom-divider" aria-hidden="true"></span>
      <button type="button" class="lightbox-zoom-mode" data-lightbox-fit aria-label="${fitPage}" title="${fitPage} (0)" aria-keyshortcuts="0">${fit}</button>
      <button type="button" class="lightbox-zoom-mode" data-lightbox-actual-size aria-label="${actualSize}" title="${actualSize} (1)" aria-keyshortcuts="1">100%</button>
    </div>
    <div class="lightbox-shortcut-hint" data-lightbox-shortcut-hint aria-label="${shortcuts}" aria-hidden="true">
      <span><kbd>←</kbd><kbd>→</kbd>${switchImage}</span>
      <span data-lightbox-task-shortcut><kbd>↑</kbd><kbd>↓</kbd>${switchTask}</span>
      <span class="lightbox-shortcut-wheel">${wheelZoom}</span>
    </div>
  `;
}

export function bindLightboxZoomChrome(root: HTMLElement, bindings: LightboxZoomBindings): void {
  root.querySelector<HTMLElement>("[data-lightbox-zoom-out]")?.addEventListener("click", bindings.zoomOut);
  root.querySelector<HTMLElement>("[data-lightbox-zoom-in]")?.addEventListener("click", bindings.zoomIn);
  root.querySelector<HTMLElement>("[data-lightbox-fit]")?.addEventListener("click", bindings.fit);
  root.querySelector<HTMLElement>("[data-lightbox-actual-size]")?.addEventListener("click", bindings.actualSize);
}

export function lightboxImageActualSizeScale(image: HTMLImageElement | null): number {
  if (!image) return LIGHTBOX_FIT_SCALE;
  return lightboxActualSizeScale(
    image.naturalWidth,
    image.naturalHeight,
    image.clientWidth,
    image.clientHeight,
  );
}

export function updateLightboxZoomChrome(
  root: HTMLElement | null,
  scale: number,
  image: HTMLImageElement | null,
): void {
  if (!root) return;
  const normalizedScale = normalizeLightboxScale(scale);
  const actualSizeScale = lightboxImageActualSizeScale(image);
  const value = root.querySelector<HTMLOutputElement>("[data-lightbox-zoom-value]");
  const zoomOut = root.querySelector<HTMLButtonElement>("[data-lightbox-zoom-out]");
  const zoomIn = root.querySelector<HTMLButtonElement>("[data-lightbox-zoom-in]");
  const fit = root.querySelector<HTMLButtonElement>("[data-lightbox-fit]");
  const actualSize = root.querySelector<HTMLButtonElement>("[data-lightbox-actual-size]");
  if (value) value.textContent = `${lightboxDisplayPercent(normalizedScale, actualSizeScale)}%`;
  if (zoomOut) zoomOut.disabled = normalizedScale <= LIGHTBOX_MIN_SCALE;
  if (zoomIn) zoomIn.disabled = normalizedScale >= LIGHTBOX_MAX_SCALE;
  fit?.setAttribute("aria-pressed", isLightboxFitScale(normalizedScale) ? "true" : "false");
  actualSize?.setAttribute(
    "aria-pressed",
    Math.abs(normalizedScale - actualSizeScale) <= LIGHTBOX_FIT_SNAP_EPSILON ? "true" : "false",
  );
}

export function showLightboxShortcutHint(root: HTMLElement | null, hasTaskNavigation: boolean): void {
  if (!root) return;
  const hint = root.querySelector<HTMLElement>("[data-lightbox-shortcut-hint]");
  const taskShortcut = root.querySelector<HTMLElement>("[data-lightbox-task-shortcut]");
  if (!hint) return;
  taskShortcut?.toggleAttribute("hidden", !hasTaskNavigation);
  const previousTimer = lightboxShortcutHintTimers.get(root);
  if (previousTimer) window.clearTimeout(previousTimer);
  hint.classList.remove("is-visible");
  hint.setAttribute("aria-hidden", "false");
  window.requestAnimationFrame(() => hint.classList.add("is-visible"));
  const timer = window.setTimeout(() => {
    hint.classList.remove("is-visible");
    hint.setAttribute("aria-hidden", "true");
    lightboxShortcutHintTimers.delete(root);
  }, LIGHTBOX_SHORTCUT_HINT_DURATION_MS);
  lightboxShortcutHintTimers.set(root, timer);
}

export function hideLightboxShortcutHint(root: HTMLElement | null): void {
  if (!root) return;
  const timer = lightboxShortcutHintTimers.get(root);
  if (timer) window.clearTimeout(timer);
  lightboxShortcutHintTimers.delete(root);
  const hint = root.querySelector<HTMLElement>("[data-lightbox-shortcut-hint]");
  hint?.classList.remove("is-visible");
  hint?.setAttribute("aria-hidden", "true");
}
