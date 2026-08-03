import {
  closeHistoryLightbox,
  openHistoryLightbox,
  syncHistoryLightboxUrls,
} from "./history-lightbox";
import type { HistoryLightboxTaskNavigation } from "./history-lightbox";
import { getLegacyBridge } from "./state";

export type LightboxOptions = {
  taskId?: string;
  onTaskNavigate?: HistoryLightboxTaskNavigation;
};

let lightboxFeatureInitialized = false;

function legacyMethod(name: string, ...args: any[]): any {
  const method = getLegacyBridge().methods[name];
  if (typeof method !== "function") {
    throw new Error("Legacy bridge method " + name + " is not available");
  }
  return method(...args);
}

function openLightbox(url: string, urls: string[] = [], index = 0, options: LightboxOptions = {}): void {
  const nextUrls = Array.isArray(urls) && urls.length
    ? urls.filter(Boolean)
    : [url].filter(Boolean);
  if (!nextUrls.length) return;
  const matchedIndex = nextUrls.indexOf(url);
  const requestedIndex = matchedIndex >= 0 ? matchedIndex : index;
  openHistoryLightbox(nextUrls, requestedIndex, options);
}

function syncActiveLightboxUrls(urls: string[]): void {
  syncHistoryLightboxUrls(urls);
}

async function addToInput(url: string): Promise<void> {
  try {
    const file = await legacyMethod("imageFileFromUrl", url, "preview-" + Date.now());
    legacyMethod("addImageFiles", [file]);
  } catch (error) {
    console.error("Failed to add image to input", error);
  }
}

export function initLightboxFeature(): void {
  if (lightboxFeatureInitialized) return;
  lightboxFeatureInitialized = true;

  window.openLightbox = openLightbox;
  window.closeLightbox = closeHistoryLightbox;
  window.addToInput = addToInput;

  Object.assign(getLegacyBridge().methods, {
    syncActiveLightboxUrls,
  });
}
