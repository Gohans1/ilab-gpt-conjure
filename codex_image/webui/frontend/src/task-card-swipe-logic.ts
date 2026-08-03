export const TASK_CARD_SWIPE_DIRECTION_LOCK_PX = 8;
export const TASK_CARD_ARCHIVE_REVEAL_PX = 30;
export const TASK_CARD_DELETE_REVEAL_PX = 38;
export const TASK_CARD_STOP_REVEAL_PX = 52;
export const TASK_CARD_SWIPE_OPEN_PX = 64;
export const TASK_CARD_SWIPE_MAX_PX = 78;
export const TASK_CARD_BLOCKED_SWIPE_MAX_PX = 16;
export const TASK_QUEUE_REORDER_DIRECTION_LOCK_PX = TASK_CARD_SWIPE_DIRECTION_LOCK_PX;
export const TASK_QUEUE_TOUCH_HOLD_MS = 280;
export const TASK_QUEUE_REORDER_HINT_STORAGE_KEY = "ilab-conjure-queue-reorder-hint-v1";
const TASK_CARD_GESTURE_AXIS_DOMINANCE_RATIO = 1.25;
const TASK_CARD_GESTURE_FORCE_COMMIT_PX = 18;

export type TaskCardSwipeAxis = "pending" | "vertical" | "horizontal";
export type TaskCardSwipeAction = "archive" | "delete" | "stop" | "promote" | "cancel";
export type TaskCardSwipeDirection = TaskCardSwipeAction | null;
export type TaskCardSwipeActions = {
  positive: TaskCardSwipeAction | null;
  negative: TaskCardSwipeAction | null;
};

export type TaskQueueReorderIntent = "pending" | "horizontal" | "scroll" | "reorder";

export function taskCardSwipeActionRequiresConfirmation(action: TaskCardSwipeAction): boolean {
  return action === "stop";
}

function resolveTaskCardGestureAxis(
  deltaX: number,
  deltaY: number,
  directionLockPx = TASK_CARD_SWIPE_DIRECTION_LOCK_PX,
): TaskCardSwipeAxis {
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  const distance = Math.hypot(deltaX, deltaY);
  if (distance < directionLockPx) return "pending";
  if (absX >= absY * TASK_CARD_GESTURE_AXIS_DOMINANCE_RATIO) return "horizontal";
  if (absY >= absX * TASK_CARD_GESTURE_AXIS_DOMINANCE_RATIO) return "vertical";
  if (distance < TASK_CARD_GESTURE_FORCE_COMMIT_PX) return "pending";
  return absX >= absY ? "horizontal" : "vertical";
}

export function resolveTaskQueueReorderIntent(
  pointerType: string,
  holdReady: boolean,
  deltaX: number,
  deltaY: number,
): TaskQueueReorderIntent {
  const axis = resolveTaskCardGestureAxis(
    deltaX,
    deltaY,
    TASK_QUEUE_REORDER_DIRECTION_LOCK_PX,
  );
  if (axis === "pending") return "pending";
  if (axis === "horizontal") return "horizontal";
  if (pointerType === "mouse" || holdReady) return "reorder";
  return "scroll";
}

export function mergeTaskQueueReorderIds(
  currentIds: string[],
  renderedIds: string[],
): string[] {
  const currentSet = new Set(currentIds);
  const reorderedVisibleIds = renderedIds.filter((taskId) => currentSet.has(taskId));
  const reorderedVisibleSet = new Set(reorderedVisibleIds);
  let visibleIndex = 0;
  return currentIds.map((taskId) => {
    if (!reorderedVisibleSet.has(taskId)) return taskId;
    return reorderedVisibleIds[visibleIndex++] || taskId;
  });
}

export const TERMINAL_TASK_CARD_SWIPE_ACTIONS: TaskCardSwipeActions = {
  positive: "archive",
  negative: "delete",
};

export function taskCardSwipeActionsForState(
  queueSection: string,
  status: string,
  localPending = false,
): TaskCardSwipeActions {
  if (localPending || ["submitting", "cancelling"].includes(status)) {
    return { positive: null, negative: null };
  }
  if (queueSection === "running") return { positive: null, negative: "stop" };
  if (queueSection === "waiting") return { positive: "promote", negative: "cancel" };
  if (["queued", "running"].includes(status)) return { positive: null, negative: null };
  return { ...TERMINAL_TASK_CARD_SWIPE_ACTIONS };
}

export type TaskCardSwipeFrame = {
  axis: TaskCardSwipeAxis;
  direction: TaskCardSwipeDirection;
  revealDirection: TaskCardSwipeAction | null;
  offset: number;
  ready: boolean;
};

export function resolveTaskCardSwipeSurfaceOffset(offset: number): number {
  const normalizedOffset = Number.isFinite(offset) ? offset : 0;
  return Math.max(
    -TASK_CARD_SWIPE_MAX_PX,
    Math.min(TASK_CARD_SWIPE_MAX_PX, normalizedOffset),
  );
}

export function resolveTaskCardSwipe(
  deltaX: number,
  deltaY: number,
  cardWidth: number,
  startOffset = 0,
  actions: TaskCardSwipeActions = TERMINAL_TASK_CARD_SWIPE_ACTIONS,
): TaskCardSwipeFrame {
  const safeWidth = Math.max(1, cardWidth);
  const axis = resolveTaskCardGestureAxis(deltaX, deltaY);

  if (axis === "pending") {
    return {
      axis: "pending",
      direction: null,
      revealDirection: null,
      offset: startOffset,
      ready: false,
    };
  }

  if (axis === "vertical") {
    return {
      axis: "vertical",
      direction: null,
      revealDirection: null,
      offset: startOffset,
      ready: false,
    };
  }

  const maxOffset = Math.min(TASK_CARD_SWIPE_MAX_PX, safeWidth * 0.36);
  const rawOffset = startOffset + deltaX;
  const positive = rawOffset >= 0;
  const direction = positive ? actions.positive : actions.negative;
  const allowedOffset = Math.max(-maxOffset, Math.min(maxOffset, rawOffset));
  const blockedOffset = Math.max(
    -TASK_CARD_BLOCKED_SWIPE_MAX_PX,
    Math.min(TASK_CARD_BLOCKED_SWIPE_MAX_PX, rawOffset * 0.2),
  );
  const offset = direction ? allowedOffset : blockedOffset;
  const revealDistance = direction === "stop"
    ? TASK_CARD_STOP_REVEAL_PX
    : positive
      ? TASK_CARD_ARCHIVE_REVEAL_PX
      : TASK_CARD_DELETE_REVEAL_PX;
  const ready = Boolean(direction) && Math.abs(offset) >= revealDistance;

  return {
    axis: "horizontal",
    direction,
    revealDirection: ready ? direction : null,
    offset,
    ready,
  };
}
