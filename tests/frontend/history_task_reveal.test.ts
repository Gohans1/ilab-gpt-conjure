import assert from "node:assert/strict";
import test from "node:test";

import {
  historyTaskRevealDestination,
  historyTaskRevealLayoutReady,
  sidebarTaskRevealPagePlan,
} from "../../codex_image/webui/frontend/src/history-task-reveal-model.ts";

const nowMs = Date.parse("2026-08-02T12:00:00+08:00");

test("recent history tasks reveal inside their real sidebar date group", () => {
  assert.deepEqual(
    historyTaskRevealDestination({ terminal_at: "2026-08-02T03:00:00Z" }, { nowMs }),
    { kind: "group", groupKey: "today" },
  );
  assert.deepEqual(
    historyTaskRevealDestination({ terminal_at: "2026-08-01T03:00:00Z" }, { nowMs }),
    { kind: "group", groupKey: "yesterday" },
  );
  assert.deepEqual(
    historyTaskRevealDestination({ terminal_at: "2026-07-28T03:00:00Z" }, { nowMs }),
    { kind: "group", groupKey: "last7" },
  );
});

test("older and archived tasks use the transient current-view group", () => {
  assert.deepEqual(
    historyTaskRevealDestination({ terminal_at: "2026-07-01T03:00:00Z" }, { nowMs }),
    { kind: "transient", groupKey: "current" },
  );
  assert.deepEqual(
    historyTaskRevealDestination(
      { terminal_at: "2026-08-02T03:00:00Z", archived_at: "2026-08-02T04:00:00Z" },
      { nowMs },
    ),
    { kind: "transient", groupKey: "current" },
  );
});

test("hidden tasks load every missing page through the target position", () => {
  assert.deepEqual(
    sidebarTaskRevealPagePlan({
      targetIndex: 249,
      targetLoaded: false,
      loadedCount: 50,
      pageSize: 100,
    }),
    { found: true, targetIndex: 249, offsets: [50, 150] },
  );
});

test("an already loaded target needs no request and a missing target cannot use the date group", () => {
  assert.deepEqual(
    sidebarTaskRevealPagePlan({
      targetIndex: 20,
      targetLoaded: true,
      loadedCount: 50,
      pageSize: 100,
    }),
    { found: true, targetIndex: 20, offsets: [] },
  );
  assert.deepEqual(
    sidebarTaskRevealPagePlan({
      targetIndex: -1,
      targetLoaded: false,
      loadedCount: 50,
      pageSize: 100,
    }),
    { found: false, targetIndex: -1, offsets: [] },
  );
});

test("a mounted task card is not ready to scroll until its expanded group finishes rendering", () => {
  assert.equal(
    historyTaskRevealLayoutReady({
      cardFound: true,
      groupRenderComplete: false,
      groupLayoutStable: false,
    }),
    false,
  );
  assert.equal(
    historyTaskRevealLayoutReady({
      cardFound: false,
      groupRenderComplete: true,
      groupLayoutStable: true,
    }),
    false,
  );
  assert.equal(
    historyTaskRevealLayoutReady({
      cardFound: true,
      groupRenderComplete: true,
      groupLayoutStable: false,
    }),
    false,
  );
  assert.equal(
    historyTaskRevealLayoutReady({
      cardFound: true,
      groupRenderComplete: true,
      groupLayoutStable: true,
    }),
    true,
  );
});
