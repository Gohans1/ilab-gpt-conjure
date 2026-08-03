import assert from "node:assert/strict";
import test from "node:test";

import * as historyGridResize from "../../codex_image/webui/frontend/src/history-grid-resize";
import { createHistoryGridResizeController } from "../../codex_image/webui/frontend/src/history-grid-resize";

test("schedules a layout only when the settled grid width changes", () => {
  let resizing = false;
  let scheduled = 0;
  const controller = createHistoryGridResizeController({
    isResizing: () => resizing,
    scheduleLayout: () => {
      scheduled += 1;
    },
  });

  controller.commitLayout(640);
  controller.observeWidth(640);
  controller.observeWidth(760);
  controller.observeWidth(760);

  assert.equal(scheduled, 1);
});

test("keeps cards stable during divider drag and accepts the final layout", () => {
  let resizing = true;
  let scheduled = 0;
  const controller = createHistoryGridResizeController({
    isResizing: () => resizing,
    scheduleLayout: () => {
      scheduled += 1;
    },
  });

  controller.commitLayout(640);
  controller.observeWidth(820);
  assert.equal(scheduled, 0);

  resizing = false;
  controller.commitLayout(820);
  controller.observeWidth(820);
  assert.equal(scheduled, 0);

  controller.observeWidth(900);
  assert.equal(scheduled, 1);
});

test("ignores unusable measurements and sub-pixel noise", () => {
  let scheduled = 0;
  const controller = createHistoryGridResizeController({
    isResizing: () => false,
    scheduleLayout: () => {
      scheduled += 1;
    },
  });

  controller.commitLayout(640);
  controller.observeWidth(Number.NaN);
  controller.observeWidth(0);
  controller.observeWidth(640.9);

  assert.equal(scheduled, 0);
});

test("never rounds a fractional grid content box above its physical width", () => {
  const availableWidth = (historyGridResize as Record<string, unknown>)
    .historyGridAvailableWidth;
  assert.equal(typeof availableWidth, "function");
  if (typeof availableWidth !== "function") return;

  assert.equal(availableWidth({
    boundingWidth: 818.91,
    clientWidth: 809,
    offsetWidth: 819,
    paddingLeft: 4,
    paddingRight: 15,
  }), 789);
  assert.equal(availableWidth({
    boundingWidth: 818,
    clientWidth: 808,
    offsetWidth: 818,
    paddingLeft: 4,
    paddingRight: 15,
  }), 789);
});

test("detects replacement cards that lost their calculated grid dimensions", () => {
  const needsLayout = (historyGridResize as Record<string, unknown>)
    .historyGridCardsNeedLayout;
  assert.equal(typeof needsLayout, "function");
  if (typeof needsLayout !== "function") return;

  const card = (width: string, rowHeight: string) => ({
    width,
    rowHeight,
  });

  assert.equal(needsLayout([]), false);
  assert.equal(needsLayout([card("220px", "220px"), card("124px", "220px")]), false);
  assert.equal(needsLayout([card("", ""), card("124px", "220px")]), true);
  assert.equal(needsLayout([card("124px", "")]), true);
  assert.equal(needsLayout([card("0px", "220px")]), true);
});
