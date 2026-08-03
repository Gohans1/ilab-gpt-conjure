import assert from "node:assert/strict";
import test from "node:test";

import * as taskCardSwipeLogic from "../../codex_image/webui/frontend/src/task-card-swipe-logic";
import {
  resolveTaskCardSwipe,
  taskCardSwipeActionRequiresConfirmation,
  taskCardSwipeActionsForState,
  TASK_CARD_ARCHIVE_REVEAL_PX,
  TASK_CARD_BLOCKED_SWIPE_MAX_PX,
  TASK_CARD_DELETE_REVEAL_PX,
  TASK_CARD_SWIPE_DIRECTION_LOCK_PX,
  TASK_CARD_SWIPE_MAX_PX,
  TASK_CARD_SWIPE_OPEN_PX,
  TASK_CARD_STOP_REVEAL_PX,
} from "../../codex_image/webui/frontend/src/task-card-swipe-logic";

test("task-card swipe action matrix follows terminal, running, waiting, and cancelling states", () => {
  assert.deepEqual(taskCardSwipeActionsForState("", "completed"), {
    positive: "archive",
    negative: "delete",
  });
  assert.deepEqual(taskCardSwipeActionsForState("running", "running"), {
    positive: null,
    negative: "stop",
  });
  assert.deepEqual(taskCardSwipeActionsForState("waiting", "queued"), {
    positive: "promote",
    negative: "cancel",
  });
  assert.deepEqual(taskCardSwipeActionsForState("running", "cancelling"), {
    positive: null,
    negative: null,
  });
});

test("waiting cancel is confirmed by the revealed drawer button while running stop keeps confirmation", () => {
  assert.equal(taskCardSwipeActionRequiresConfirmation("cancel"), false);
  assert.equal(taskCardSwipeActionRequiresConfirmation("stop"), true);
  assert.equal(taskCardSwipeActionRequiresConfirmation("delete"), false);
});

test("task-card swipe moves the complete rigid card by the full gesture offset", () => {
  const resolveSurfaceOffset = (
    taskCardSwipeLogic as typeof taskCardSwipeLogic & {
      resolveTaskCardSwipeSurfaceOffset?: (offset: number) => number;
    }
  ).resolveTaskCardSwipeSurfaceOffset;

  assert.equal(typeof resolveSurfaceOffset, "function");
  assert.equal(resolveSurfaceOffset?.(0), 0);
  assert.equal(
    resolveSurfaceOffset?.(TASK_CARD_SWIPE_OPEN_PX / 2),
    TASK_CARD_SWIPE_OPEN_PX / 2,
  );
  assert.equal(resolveSurfaceOffset?.(TASK_CARD_SWIPE_OPEN_PX), TASK_CARD_SWIPE_OPEN_PX);
  assert.equal(resolveSurfaceOffset?.(-TASK_CARD_SWIPE_OPEN_PX), -TASK_CARD_SWIPE_OPEN_PX);
  assert.equal(resolveSurfaceOffset?.(TASK_CARD_SWIPE_MAX_PX), TASK_CARD_SWIPE_MAX_PX);
});

test("task-card swipe preserves clicks and vertical scrolling before horizontal intent", () => {
  assert.equal(
    resolveTaskCardSwipe(TASK_CARD_SWIPE_DIRECTION_LOCK_PX - 1, 0, 300).axis,
    "pending",
  );
  assert.equal(resolveTaskCardSwipe(9, 8, 300).axis, "pending");
  assert.equal(resolveTaskCardSwipe(12, 4, 300).axis, "horizontal");
  assert.equal(resolveTaskCardSwipe(9, 16, 300).axis, "vertical");
});

test("task-card swipe reveals the archive drawer without executing an action", () => {
  const beforeThreshold = resolveTaskCardSwipe(
    TASK_CARD_ARCHIVE_REVEAL_PX - 1,
    2,
    300,
  );
  assert.equal(beforeThreshold.axis, "horizontal");
  assert.equal(beforeThreshold.direction, "archive");
  assert.equal(beforeThreshold.revealDirection, null);

  const revealed = resolveTaskCardSwipe(
    TASK_CARD_ARCHIVE_REVEAL_PX + 1,
    2,
    300,
  );
  assert.equal(revealed.direction, "archive");
  assert.equal(revealed.revealDirection, "archive");
  assert.equal(revealed.ready, true);
  assert.equal("action" in revealed, false);
});

test("task-card swipe requires a stricter left threshold before revealing deletion", () => {
  assert.ok(TASK_CARD_DELETE_REVEAL_PX > TASK_CARD_ARCHIVE_REVEAL_PX);

  const archiveDistanceIsNotEnough = resolveTaskCardSwipe(
    -(TASK_CARD_ARCHIVE_REVEAL_PX + 1),
    2,
    300,
  );
  assert.equal(archiveDistanceIsNotEnough.direction, "delete");
  assert.equal(archiveDistanceIsNotEnough.revealDirection, null);

  const revealed = resolveTaskCardSwipe(
    -(TASK_CARD_DELETE_REVEAL_PX + 1),
    2,
    300,
  );
  assert.equal(revealed.direction, "delete");
  assert.equal(revealed.revealDirection, "delete");
  assert.equal(revealed.ready, true);
});

test("task-card swipe caps mechanical drawer travel at a fixed compact distance", () => {
  const revealed = resolveTaskCardSwipe(600, 0, 300);
  assert.equal(revealed.revealDirection, "archive");
  assert.equal(revealed.offset, TASK_CARD_SWIPE_MAX_PX);
  assert.ok(TASK_CARD_SWIPE_MAX_PX < 300);
});

test("an open drawer can be dragged back under the reveal threshold to close", () => {
  const closing = resolveTaskCardSwipe(
    -(TASK_CARD_SWIPE_OPEN_PX - TASK_CARD_ARCHIVE_REVEAL_PX + 1),
    0,
    300,
    TASK_CARD_SWIPE_OPEN_PX,
  );
  assert.equal(closing.axis, "horizontal");
  assert.equal(closing.direction, "archive");
  assert.equal(closing.revealDirection, null);
  assert.ok(closing.offset > 0);
});

test("running task cards require a deliberate left swipe to reveal stop and elastically reject right swipe", () => {
  const actions = { positive: null, negative: "stop" } as const;
  assert.ok(TASK_CARD_STOP_REVEAL_PX > TASK_CARD_DELETE_REVEAL_PX);

  const accidental = resolveTaskCardSwipe(
    -(TASK_CARD_STOP_REVEAL_PX - 1),
    0,
    300,
    0,
    actions,
  );
  assert.equal(accidental.direction, "stop");
  assert.equal(accidental.revealDirection, null);

  const stopped = resolveTaskCardSwipe(
    -(TASK_CARD_STOP_REVEAL_PX + 1),
    0,
    300,
    0,
    actions,
  );
  assert.equal(stopped.direction, "stop");
  assert.equal(stopped.revealDirection, "stop");

  const rejected = resolveTaskCardSwipe(120, 0, 300, 0, actions);
  assert.equal(rejected.direction, null);
  assert.equal(rejected.revealDirection, null);
  assert.ok(rejected.offset > 0);
  assert.ok(rejected.offset <= TASK_CARD_BLOCKED_SWIPE_MAX_PX);
});

test("waiting task cards reveal promote to the right and cancel to the left", () => {
  const actions = { positive: "promote", negative: "cancel" } as const;
  const promoted = resolveTaskCardSwipe(
    TASK_CARD_ARCHIVE_REVEAL_PX + 1,
    0,
    300,
    0,
    actions,
  );
  assert.equal(promoted.revealDirection, "promote");

  const cancelled = resolveTaskCardSwipe(
    -(TASK_CARD_DELETE_REVEAL_PX + 1),
    0,
    300,
    0,
    actions,
  );
  assert.equal(cancelled.revealDirection, "cancel");
});

test("waiting task reorder distinguishes horizontal swipe, vertical scroll, and deliberate vertical drag", () => {
  const resolveQueueReorderIntent = (
    taskCardSwipeLogic as typeof taskCardSwipeLogic & {
      resolveTaskQueueReorderIntent?: (
        pointerType: string,
        holdReady: boolean,
        deltaX: number,
        deltaY: number,
      ) => "pending" | "horizontal" | "scroll" | "reorder";
    }
  ).resolveTaskQueueReorderIntent;

  assert.equal(typeof resolveQueueReorderIntent, "function");
  assert.equal(resolveQueueReorderIntent?.("mouse", true, 2, 5), "pending");
  assert.equal(resolveQueueReorderIntent?.("mouse", true, 7, 2), "pending");
  assert.equal(resolveQueueReorderIntent?.("mouse", true, 9, 8), "pending");
  assert.equal(resolveQueueReorderIntent?.("mouse", true, 10, 3), "horizontal");
  assert.equal(resolveQueueReorderIntent?.("mouse", true, 7, 10), "reorder");
  assert.equal(resolveQueueReorderIntent?.("mouse", true, 2, 8), "reorder");
  assert.equal(resolveQueueReorderIntent?.("touch", false, 2, 8), "scroll");
  assert.equal(resolveQueueReorderIntent?.("touch", true, 2, 8), "reorder");
});

test("waiting task reorder preserves queue entries that arrive while a card is being dragged", () => {
  const mergeQueueReorderIds = (
    taskCardSwipeLogic as typeof taskCardSwipeLogic & {
      mergeTaskQueueReorderIds?: (currentIds: string[], renderedIds: string[]) => string[];
    }
  ).mergeTaskQueueReorderIds;

  assert.equal(typeof mergeQueueReorderIds, "function");
  assert.deepEqual(
    mergeQueueReorderIds?.(
      ["task-a", "task-new", "task-b", "task-c"],
      ["task-c", "task-a", "task-b"],
    ),
    ["task-c", "task-new", "task-a", "task-b"],
  );
  assert.deepEqual(
    mergeQueueReorderIds?.(
      ["task-a", "task-c"],
      ["task-c", "task-a", "task-removed"],
    ),
    ["task-c", "task-a"],
  );
});
