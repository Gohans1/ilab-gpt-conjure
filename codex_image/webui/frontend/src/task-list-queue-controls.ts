import { moveQueueTask, reorderQueue } from "./queue";
import {
  mergeTaskQueueReorderIds,
  resolveTaskQueueReorderIntent,
  TASK_QUEUE_REORDER_HINT_STORAGE_KEY,
  TASK_QUEUE_TOUCH_HOLD_MS,
} from "./task-card-swipe-logic";
import { getLegacyBridge } from "./state";
import { prefersReducedMotion } from "./webui-utils";

const bridge = getLegacyBridge();
const state = bridge.state;
const els = bridge.els;
const TASK_QUEUE_AUTOSCROLL_EDGE_PX = 32;
const TASK_QUEUE_AUTOSCROLL_STEP_PX = 12;
const TASK_QUEUE_TOUCH_MOVE_OPTIONS: AddEventListenerOptions = { passive: false };

type ActiveQueueReorderPointer = {
  pointerId: number;
  pointerType: string;
  card: HTMLElement;
  section: HTMLElement | null;
  captureTarget: HTMLElement | null;
  placeholder: HTMLElement | null;
  startX: number;
  startY: number;
  holdReady: boolean;
  holdTimerId: number | null;
  active: boolean;
  originalOrder: string[];
};

let taskListQueueControlsInitialized = false;
let taskListQueueControlsBound = false;
let activeQueueReorderPointer: ActiveQueueReorderPointer | null = null;

function eventTargetElement(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

function taskListQueueControlRoots(): HTMLElement[] {
  return [els.taskActiveList, els.taskList].filter((root): root is HTMLElement => root instanceof HTMLElement);
}

function bindTaskListQueueControls(): void {
  if (taskListQueueControlsBound) return;
  taskListQueueControlsBound = true;
  taskListQueueControlRoots().forEach((root) => {
    root.addEventListener("pointerdown", handleTaskQueueReorderPointerDown);
    root.addEventListener("keydown", handleTaskQueueReorderKeydown);
  });
  document.addEventListener("keydown", handleTaskQueueReorderDocumentKeydown);
  document.addEventListener("visibilitychange", handleTaskQueueReorderVisibilityChange);
  window.addEventListener("blur", handleTaskQueueReorderWindowBlur);
}

function waitingQueueSectionItems(): HTMLElement | null {
  for (const root of taskListQueueControlRoots()) {
    const section = root.querySelector("[data-active-task-section=\"waiting\"] .task-active-section-items");
    if (section instanceof HTMLElement) return section;
  }
  return null;
}

function waitingQueueDomOrder(): string[] {
  const section = waitingQueueSectionItems();
  return Array.from(section?.querySelectorAll("[data-queue-task-id]") || [])
    .map((card) => String((card as HTMLElement).dataset.queueTaskId || ""))
    .filter(Boolean);
}

function sameQueueOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((taskId, index) => taskId === right[index]);
}

function restoreWaitingQueueDomOrder(taskIds: string[]): void {
  const section = waitingQueueSectionItems();
  if (!section) return;
  const cards = new Map(
    Array.from(section.querySelectorAll("[data-queue-task-id]"))
      .map((card) => [String((card as HTMLElement).dataset.queueTaskId || ""), card as HTMLElement] as [string, HTMLElement]),
  );
  taskIds.forEach((taskId) => {
    const card = cards.get(taskId);
    if (card) section.append(card);
  });
}

function animateWaitingQueueReorder(applyReorder: () => void): void {
  const section = waitingQueueSectionItems();
  if (!section || prefersReducedMotion()) {
    applyReorder();
    return;
  }
  const cards = Array.from(section.querySelectorAll<HTMLElement>("[data-queue-task-id]"))
    .filter((card) => !card.classList.contains("queue-dragging"));
  const previousTops = new Map(cards.map((card) => [card, card.getBoundingClientRect().top]));
  applyReorder();
  cards.forEach((card) => {
    const previousTop = previousTops.get(card);
    if (previousTop === undefined) return;
    const dy = previousTop - card.getBoundingClientRect().top;
    if (Math.abs(dy) > 0.5) {
      card.animate(
        [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0px)" }],
        { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
      );
    }
  });
}

function dismissQueueReorderHint(): void {
  try {
    window.localStorage.setItem(TASK_QUEUE_REORDER_HINT_STORAGE_KEY, "1");
  } catch {
    // Ignore storage errors in restricted browser contexts.
  }
  document.querySelectorAll(".task-queue-reorder-hint").forEach((hint) => hint.remove());
}

function suppressTaskClickAfterQueueReorder(): void {
  state.suppressTaskClickAfterDrag = true;
  window.setTimeout(() => {
    state.suppressTaskClickAfterDrag = false;
  }, 0);
}

function clearQueueReorderHoldTimer(pointer: ActiveQueueReorderPointer): void {
  if (pointer.holdTimerId === null) return;
  window.clearTimeout(pointer.holdTimerId);
  pointer.holdTimerId = null;
}

function startQueueReorderPointerTracking(pointer: ActiveQueueReorderPointer): void {
  activeQueueReorderPointer = pointer;
  window.addEventListener("pointermove", handleTaskQueueReorderPointerMove);
  window.addEventListener("pointerup", handleTaskQueueReorderPointerUp);
  window.addEventListener("pointercancel", handleTaskQueueReorderPointerCancel);
  if (pointer.pointerType !== "mouse") {
    window.addEventListener("touchmove", handleTaskQueueReorderTouchMove, TASK_QUEUE_TOUCH_MOVE_OPTIONS);
  }
}

function releaseQueueReorderPointerCapture(pointer: ActiveQueueReorderPointer): void {
  const captureTarget = pointer.captureTarget;
  captureTarget?.removeEventListener("lostpointercapture", handleTaskQueueReorderLostPointerCapture);
  if (captureTarget) {
    try {
      if (captureTarget.hasPointerCapture(pointer.pointerId)) {
        captureTarget.releasePointerCapture(pointer.pointerId);
      }
    } catch {
      // Capture may already have been cleared by the browser.
    }
  }
  pointer.captureTarget = null;
}

function stopQueueReorderPointerTracking(pointer: ActiveQueueReorderPointer): void {
  clearQueueReorderHoldTimer(pointer);
  pointer.card.classList.remove("queue-reorder-armed");
  window.removeEventListener("pointermove", handleTaskQueueReorderPointerMove);
  window.removeEventListener("pointerup", handleTaskQueueReorderPointerUp);
  window.removeEventListener("pointercancel", handleTaskQueueReorderPointerCancel);
  window.removeEventListener("touchmove", handleTaskQueueReorderTouchMove, TASK_QUEUE_TOUCH_MOVE_OPTIONS);
  if (activeQueueReorderPointer === pointer) activeQueueReorderPointer = null;
  releaseQueueReorderPointerCapture(pointer);
}

function queueReorderCardFromEvent(event: PointerEvent): HTMLElement | null {
  if (state.batchMode || !event.isPrimary) return null;
  if (event.pointerType === "mouse" && event.button !== 0) return null;
  const target = eventTargetElement(event);
  if (!target || target.closest("button, input, select, textarea, a")) return null;
  const card = target.closest('[data-queue-reorderable="true"]');
  return card instanceof HTMLElement ? card : null;
}

function createQueueDropPlaceholder(card: HTMLElement): HTMLElement {
  const rect = card.getBoundingClientRect();
  const placeholder = document.createElement("div");
  placeholder.className = "task-queue-drop-placeholder";
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.style.height = `${rect.height}px`;
  card.before(placeholder);
  return placeholder;
}

function captureQueueReorderPointer(
  pointer: ActiveQueueReorderPointer,
  section: HTMLElement,
): boolean {
  try {
    section.setPointerCapture(pointer.pointerId);
    pointer.captureTarget = section;
    section.addEventListener("lostpointercapture", handleTaskQueueReorderLostPointerCapture);
    return true;
  } catch {
    return false;
  }
}

function rollbackQueueReorderStart(pointer: ActiveQueueReorderPointer): void {
  const { card, placeholder, section } = pointer;
  pointer.active = false;
  state.queueDragTaskId = null;
  if (section && placeholder?.isConnected) {
    section.insertBefore(card, placeholder);
    placeholder.remove();
  } else if (section && card.parentElement !== section) {
    section.append(card);
  }
  clearDraggedQueueCardStyles(card);
  section?.classList.remove("task-queue-reordering");
  releaseQueueReorderPointerCapture(pointer);
  pointer.placeholder = null;
}

function beginQueueReorder(pointer: ActiveQueueReorderPointer): boolean {
  const section = waitingQueueSectionItems();
  const dragLayer = els.taskQueueDragLayer;
  const sidebar = els.sidebar;
  if (
    !section
    || pointer.card.parentElement !== section
    || !(dragLayer instanceof HTMLElement)
    || !(sidebar instanceof HTMLElement)
  ) return false;
  getLegacyBridge().methods.cancelActiveTaskCardSwipeTracking?.({ releaseCapture: false });
  getLegacyBridge().methods.closeOpenTaskCardDrawer?.({ immediate: true });
  pointer.section = section;
  if (!captureQueueReorderPointer(pointer, section)) {
    pointer.section = null;
    return false;
  }
  const rect = pointer.card.getBoundingClientRect();
  const sidebarRect = sidebar.getBoundingClientRect();
  try {
    pointer.originalOrder = waitingQueueDomOrder();
    pointer.placeholder = createQueueDropPlaceholder(pointer.card);
    pointer.card.classList.remove("queue-reorder-armed");
    pointer.card.classList.add("queue-dragging");
    pointer.card.style.position = "absolute";
    pointer.card.style.left = `${rect.left - sidebarRect.left}px`;
    pointer.card.style.top = `${rect.top - sidebarRect.top}px`;
    pointer.card.style.width = `${rect.width}px`;
    pointer.card.style.height = `${rect.height}px`;
    pointer.card.style.setProperty("--task-queue-drag-y", "0px");
    dragLayer.append(pointer.card);
    section.classList.add("task-queue-reordering");
    pointer.active = true;
    state.queueDragTaskId = String(pointer.card.dataset.queueTaskId || "");
    dismissQueueReorderHint();
    return true;
  } catch {
    rollbackQueueReorderStart(pointer);
    return false;
  }
}

function clearDraggedQueueCardStyles(card: HTMLElement): void {
  card.classList.remove("queue-dragging", "queue-reorder-armed");
  card.style.removeProperty("position");
  card.style.removeProperty("left");
  card.style.removeProperty("top");
  card.style.removeProperty("width");
  card.style.removeProperty("height");
  card.style.removeProperty("--task-queue-drag-y");
}

function moveWaitingQueueDropPlaceholder(pointer: ActiveQueueReorderPointer, clientY: number): void {
  const { card, placeholder, section } = pointer;
  if (!section || !placeholder?.isConnected) return;
  const cards = Array.from(section.querySelectorAll<HTMLElement>("[data-queue-task-id]"))
    .filter((candidate) => candidate !== card);
  const beforeCard = cards.find((candidate) => {
    const rect = candidate.getBoundingClientRect();
    return clientY < rect.top + rect.height / 2;
  });
  if (beforeCard) {
    if (placeholder.nextElementSibling === beforeCard) return;
    animateWaitingQueueReorder(() => section.insertBefore(placeholder, beforeCard));
    return;
  }
  if (placeholder === section.lastElementChild) return;
  animateWaitingQueueReorder(() => section.append(placeholder));
}

function autoScrollWaitingQueue(pointer: ActiveQueueReorderPointer, clientY: number): void {
  const scroller = pointer.section?.closest<HTMLElement>(".task-active-list, .sidebar-content");
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
  const rect = scroller.getBoundingClientRect();
  const topDistance = clientY - rect.top;
  const bottomDistance = rect.bottom - clientY;
  const delta = topDistance < TASK_QUEUE_AUTOSCROLL_EDGE_PX
    ? -TASK_QUEUE_AUTOSCROLL_STEP_PX
    : bottomDistance < TASK_QUEUE_AUTOSCROLL_EDGE_PX
      ? TASK_QUEUE_AUTOSCROLL_STEP_PX
      : 0;
  if (delta) scroller.scrollTop += delta;
}

function updateQueueReorder(pointer: ActiveQueueReorderPointer, event: PointerEvent): void {
  pointer.card.style.setProperty("--task-queue-drag-y", `${event.clientY - pointer.startY}px`);
  autoScrollWaitingQueue(pointer, event.clientY);
  moveWaitingQueueDropPlaceholder(pointer, event.clientY);
}

function finishQueueReorder(
  pointer: ActiveQueueReorderPointer,
  commit: boolean,
  options: { flushDeferred?: boolean } = {},
): void {
  stopQueueReorderPointerTracking(pointer);
  if (!pointer.active) return;
  const { card, placeholder, section } = pointer;
  if (section && placeholder?.isConnected) {
    section.insertBefore(card, placeholder);
    placeholder.remove();
  }
  clearDraggedQueueCardStyles(card);
  section?.classList.remove("task-queue-reordering");
  state.queueDragTaskId = null;
  suppressTaskClickAfterQueueReorder();
  if (!commit) {
    if (pointer.originalOrder.length && !sameQueueOrder(pointer.originalOrder, waitingQueueDomOrder())) {
      animateWaitingQueueReorder(() => restoreWaitingQueueDomOrder(pointer.originalOrder));
    }
    if (options.flushDeferred !== false) {
      getLegacyBridge().methods.flushDeferredActiveTaskGroupRender?.();
    }
    return;
  }
  const visibleReorderedIds = waitingQueueDomOrder();
  const currentWaitingIds = (state.queue.waiting || [])
    .map((task: any) => String(task.task_id || ""))
    .filter(Boolean);
  const reorderedIds = mergeTaskQueueReorderIds(currentWaitingIds, visibleReorderedIds);
  if (reorderedIds.length && !sameQueueOrder(currentWaitingIds, reorderedIds)) {
    const waitingById = new Map(
      (state.queue.waiting || []).map((task: any) => [String(task.task_id || ""), task]),
    );
    state.queue = {
      ...state.queue,
      waiting: reorderedIds.map((taskId) => waitingById.get(taskId)).filter(Boolean),
    };
    getLegacyBridge().methods.discardDeferredActiveTaskGroupRender?.();
    state.tasksRenderKey = null;
    getLegacyBridge().methods.renderTasks?.({ preserveScroll: true });
    void reorderQueue(reorderedIds);
    return;
  }
  if (options.flushDeferred !== false) {
    getLegacyBridge().methods.flushDeferredActiveTaskGroupRender?.();
  }
}

function cancelActiveTaskQueueReorder(options: { flushDeferred?: boolean } = {}): boolean {
  const pointer = activeQueueReorderPointer;
  if (!pointer?.active) return false;
  finishQueueReorder(pointer, false, options);
  return true;
}

function handleTaskQueueReorderPointerDown(event: PointerEvent): void {
  const card = queueReorderCardFromEvent(event);
  if (!card) return;
  if (activeQueueReorderPointer) finishQueueReorder(activeQueueReorderPointer, false);
  const pointer: ActiveQueueReorderPointer = {
    pointerId: event.pointerId,
    pointerType: event.pointerType || "mouse",
    card,
    section: null,
    captureTarget: null,
    placeholder: null,
    startX: event.clientX,
    startY: event.clientY,
    holdReady: event.pointerType === "mouse",
    holdTimerId: null,
    active: false,
    originalOrder: [],
  };
  if (!pointer.holdReady) {
    pointer.holdTimerId = window.setTimeout(() => {
      if (activeQueueReorderPointer !== pointer || pointer.active) return;
      pointer.holdTimerId = null;
      pointer.holdReady = true;
      pointer.card.classList.add("queue-reorder-armed");
    }, TASK_QUEUE_TOUCH_HOLD_MS);
  }
  startQueueReorderPointerTracking(pointer);
}

function handleTaskQueueReorderPointerMove(event: PointerEvent): void {
  const pointer = activeQueueReorderPointer;
  if (!pointer || event.pointerId !== pointer.pointerId) return;
  if (event.pointerType === "mouse" && (event.buttons & 1) !== 1) {
    finishQueueReorder(pointer, false);
    return;
  }
  if (pointer.active) {
    if (event.cancelable) event.preventDefault();
    updateQueueReorder(pointer, event);
    return;
  }
  const intent = resolveTaskQueueReorderIntent(
    pointer.pointerType,
    pointer.holdReady,
    event.clientX - pointer.startX,
    event.clientY - pointer.startY,
  );
  if (intent === "pending") return;
  if (intent !== "reorder") {
    stopQueueReorderPointerTracking(pointer);
    return;
  }
  if (!beginQueueReorder(pointer)) {
    stopQueueReorderPointerTracking(pointer);
    return;
  }
  if (event.cancelable) event.preventDefault();
  updateQueueReorder(pointer, event);
}

function handleTaskQueueReorderTouchMove(event: TouchEvent): void {
  const pointer = activeQueueReorderPointer;
  if (!pointer || pointer.pointerType === "mouse" || !pointer.holdReady) return;
  if (event.cancelable) event.preventDefault();
}

function handleTaskQueueReorderPointerUp(event: PointerEvent): void {
  const pointer = activeQueueReorderPointer;
  if (!pointer || event.pointerId !== pointer.pointerId) return;
  if (pointer.active) {
    if (event.cancelable) event.preventDefault();
    finishQueueReorder(pointer, true);
    return;
  }
  const suppressLongPressClick = pointer.holdReady && pointer.pointerType !== "mouse";
  stopQueueReorderPointerTracking(pointer);
  if (suppressLongPressClick) suppressTaskClickAfterQueueReorder();
}

function handleTaskQueueReorderPointerCancel(event: PointerEvent): void {
  const pointer = activeQueueReorderPointer;
  if (!pointer || event.pointerId !== pointer.pointerId) return;
  finishQueueReorder(pointer, false);
}

function handleTaskQueueReorderLostPointerCapture(event: PointerEvent): void {
  const pointer = activeQueueReorderPointer;
  if (!pointer || event.pointerId !== pointer.pointerId) return;
  finishQueueReorder(pointer, false);
}

function handleTaskQueueReorderWindowBlur(): void {
  if (activeQueueReorderPointer) finishQueueReorder(activeQueueReorderPointer, false);
}

function handleTaskQueueReorderVisibilityChange(): void {
  if (document.visibilityState === "hidden") handleTaskQueueReorderWindowBlur();
}

function handleTaskQueueReorderDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !activeQueueReorderPointer?.active) return;
  event.preventDefault();
  const card = activeQueueReorderPointer.card;
  finishQueueReorder(activeQueueReorderPointer, false);
  card.focus({ preventScroll: true });
}

function handleTaskQueueReorderKeydown(event: KeyboardEvent): void {
  if (
    !event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || (event.key !== "ArrowUp" && event.key !== "ArrowDown")
  ) return;
  const target = eventTargetElement(event);
  const card = target?.closest('[data-queue-reorderable="true"]');
  if (!(card instanceof HTMLElement)) return;
  event.preventDefault();
  event.stopPropagation();
  moveQueueTask(card.dataset.queueTaskId, event.key === "ArrowUp" ? "up" : "down");
}

export function initTaskListQueueControlsFeature(): void {
  if (taskListQueueControlsInitialized) return;
  taskListQueueControlsInitialized = true;
  Object.assign(getLegacyBridge().methods, {
    bindTaskListQueueControls,
    cancelActiveTaskQueueReorder,
    handleTaskQueueReorderPointerDown,
    handleTaskQueueReorderPointerMove,
    handleTaskQueueReorderPointerUp,
    handleTaskQueueReorderPointerCancel,
    handleTaskQueueReorderKeydown,
  });
  bindTaskListQueueControls();
}
