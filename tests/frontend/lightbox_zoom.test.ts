import assert from "node:assert/strict";
import test from "node:test";

import {
  isLightboxAtOrBelowFitScale,
  lightboxActionForKey,
  lightboxActualSizeScale,
  lightboxDisplayPercent,
  lightboxScaleFromWheel,
  normalizeLightboxScale,
  shouldCloseLightboxFromClick,
} from "../../codex_image/webui/frontend/src/lightbox-controls";

test("wheel zoom snaps back to the fitted state", () => {
  assert.equal(normalizeLightboxScale(1.005), 1);
  assert.equal(normalizeLightboxScale(0.995), 1);
  assert.equal(lightboxScaleFromWheel(1.5, 99), 1);
  assert.equal(normalizeLightboxScale(1.05), 1.05);
});

test("edge images stay available at or below the fitted scale", () => {
  assert.equal(isLightboxAtOrBelowFitScale(1), true);
  assert.equal(isLightboxAtOrBelowFitScale(0.75), true);
  assert.equal(isLightboxAtOrBelowFitScale(0.1), true);
  assert.equal(isLightboxAtOrBelowFitScale(1.05), false);
});

test("blank lightbox descendants dismiss while images and controls do not", () => {
  const root = { closest: () => null } as unknown as HTMLElement;
  const blankFrame = { closest: () => null } as unknown as EventTarget;
  const image = { closest: () => ({}) } as unknown as EventTarget;
  const toolbarGap = { closest: () => ({}) } as unknown as EventTarget;

  assert.equal(shouldCloseLightboxFromClick(root, root), true);
  assert.equal(shouldCloseLightboxFromClick(blankFrame, root), true);
  assert.equal(shouldCloseLightboxFromClick(image, root), false);
  assert.equal(shouldCloseLightboxFromClick(toolbarGap, root), false);
  assert.equal(shouldCloseLightboxFromClick(null, root), false);
});

test("actual-size scale and percentage are based on the untransformed fitted image", () => {
  assert.equal(lightboxActualSizeScale(3840, 2160, 960, 540), 4);
  assert.equal(lightboxDisplayPercent(1, 4), 25);
  assert.equal(lightboxDisplayPercent(4, 4), 100);
});

test("both lightboxes use one keyboard action map", () => {
  assert.equal(lightboxActionForKey("ArrowLeft"), "previous-image");
  assert.equal(lightboxActionForKey("ArrowRight"), "next-image");
  assert.equal(lightboxActionForKey("ArrowUp"), "previous-task");
  assert.equal(lightboxActionForKey("ArrowDown"), "next-task");
  assert.equal(lightboxActionForKey("PageUp"), "previous-task");
  assert.equal(lightboxActionForKey("PageDown"), "next-task");
  assert.equal(lightboxActionForKey("0"), "fit");
  assert.equal(lightboxActionForKey("1"), "actual-size");
  assert.equal(lightboxActionForKey("+"), "zoom-in");
  assert.equal(lightboxActionForKey("="), "zoom-in");
  assert.equal(lightboxActionForKey("-"), "zoom-out");
  assert.equal(lightboxActionForKey("Escape"), null);
});
