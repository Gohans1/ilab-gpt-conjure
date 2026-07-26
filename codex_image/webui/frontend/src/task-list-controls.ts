import { getLegacyBridge } from "./state";

const bridge = getLegacyBridge();
const state = bridge.state;
const els = bridge.els;

function legacyMethod(name: string, ...args: any[]): any {
  const method = getLegacyBridge().methods[name];
  if (typeof method !== "function") {
    throw new Error("Legacy bridge method " + name + " is not available");
  }
  return method(...args);
}

const renderTasks = () => legacyMethod("renderTasks");
const syncTaskSearchHistoryResults = () => legacyMethod("syncTaskSearchHistoryResults");
const taskSearchQuery = () => legacyMethod("taskSearchQuery");
const filteredVisibleTasks = (...args: any[]) => legacyMethod("filteredVisibleTasks", ...args);
const taskHistoryGroups = (...args: any[]) => legacyMethod("taskHistoryGroups", ...args);
const taskGroupCount = (...args: any[]) => legacyMethod("taskGroupCount", ...args);
const setExpandedTaskGroupKey = (...args: any[]) => legacyMethod("setExpandedTaskGroupKey", ...args);
const scrollExpandedTaskGroupToTop = (...args: any[]) => legacyMethod("scrollExpandedTaskGroupToTop", ...args);
const captureTaskHistoryLayout = (...args: any[]) => legacyMethod("captureTaskHistoryLayout", ...args);
const animateTaskHistoryLayout = (...args: any[]) => legacyMethod("animateTaskHistoryLayout", ...args);
const archiveTask = (...args: any[]) => legacyMethod("archiveTask", ...args);
const openTaskDeleteConfirm = (...args: any[]) => legacyMethod("openTaskDeleteConfirm", ...args);
const toggleBatchMode = (...args: any[]) => legacyMethod("toggleBatchMode", ...args);
const toggleBatchTaskSelection = (...args: any[]) => legacyMethod("toggleBatchTaskSelection", ...args);
const handleBatchTaskShortcutSelection = (...args: any[]) => legacyMethod("handleBatchTaskShortcutSelection", ...args);
const archiveSelectedTasks = (...args: any[]) => legacyMethod("archiveSelectedTasks", ...args);
const selectActiveTasksForBatchCancel = (...args: any[]) => legacyMethod("selectActiveTasksForBatchCancel", ...args);
const openBatchCancelConfirm = (...args: any[]) => legacyMethod("openBatchCancelConfirm", ...args);
const openBatchDeleteConfirm = (...args: any[]) => legacyMethod("openBatchDeleteConfirm", ...args);
const selectAllMatchingTasksInExpandedGroup = (...args: any[]) => legacyMethod("selectAllMatchingTasksInExpandedGroup", ...args);
const handleTaskListPointerDown = (...args: any[]) => legacyMethod("handleTaskListPointerDown", ...args);
const loadMoreSidebarTaskGroup = (...args: any[]) => legacyMethod("loadMoreSidebarTaskGroup", ...args);
const closeArchiveModal = (...args: any[]) => legacyMethod("closeArchiveModal", ...args);

let taskListControlsInitialized = false;
let taskListControlEventsBound = false;

function taskFilterControls() {
  return [els.taskStatusFilter, els.taskRatioFilter, els.taskOrientationFilter, els.taskPromptFidelityFilter, els.taskResolutionFilter].filter(Boolean);
}

function activeTaskFilterCount() {
  return taskFilterControls().filter((element: any) => Boolean(element.value)).length;
}

function taskSearchHasValue() {
  return Boolean(String(els.taskSearch?.value || "").trim());
}

function updateTaskSearchClearButton() {
  if (!els.taskSearchClearButton) return;
  els.taskSearchClearButton.hidden = !taskSearchHasValue();
}

function clearTaskSearch() {
  if (!els.taskSearch?.value) return;
  els.taskSearch.value = "";
  updateTaskSearchClearButton();
  renderTasks();
  void syncTaskSearchHistoryResults();
  els.taskSearch.focus({ preventScroll: true });
}

function setTaskFilterPopoverOpen(open: boolean) {
  if (!els.taskFilterPopover || !els.taskFilterButton) return;
  els.taskFilterPopover.hidden = !open;
  els.taskFilterButton.setAttribute("aria-expanded", open ? "true" : "false");
  els.taskFilterButton.classList.toggle("is-open", open);
}

function toggleTaskFilterPopover() {
  setTaskFilterPopoverOpen(Boolean(els.taskFilterPopover?.hidden));
}

function clearTaskFilters(options: any = {}) {
  let changed = false;
  taskFilterControls().forEach((element: any) => {
    if (element.value) {
      element.value = "";
      changed = true;
    }
  });
  updateTaskFilterSummary();
  if (changed && options.render !== false) {
    renderTasks();
  }
}

function updateTaskFilterSummary() {
  const activeCount = activeTaskFilterCount();
  if (els.taskFilterActiveCount) {
    els.taskFilterActiveCount.hidden = activeCount === 0;
    els.taskFilterActiveCount.textContent = activeCount ? String(activeCount) : "";
  }
  els.taskFilterButton?.classList.toggle("has-active-filters", activeCount > 0);
  if (els.taskFilterClearButton) {
    els.taskFilterClearButton.disabled = activeCount === 0;
  }
}

function handleTaskFilterKeydown(event: any) {
  if (event.key !== "Escape" || els.taskFilterPopover?.hidden) return;
  event.preventDefault();
  setTaskFilterPopoverOpen(false);
  els.taskFilterButton?.focus?.();
}

function bindTaskListControlEvents() {
  if (taskListControlEventsBound) return;
  taskListControlEventsBound = true;

  els.archiveModalClose?.addEventListener("click", closeArchiveModal);
  els.archiveModal?.addEventListener("click", (event: any) => {
    if (event.target === els.archiveModal) closeArchiveModal();
  });
  els.batchCancelTasksButton?.addEventListener("click", selectActiveTasksForBatchCancel);
  els.batchManageButton?.addEventListener("click", () => toggleBatchMode());
  els.batchSelectGroupButton?.addEventListener("click", selectAllMatchingTasksInExpandedGroup);
  els.batchArchiveButton?.addEventListener("click", archiveSelectedTasks);
  els.batchCancelSelectedButton?.addEventListener("click", openBatchCancelConfirm);
  els.batchDeleteButton?.addEventListener("click", openBatchDeleteConfirm);
  els.batchCancelButton?.addEventListener("click", () => toggleBatchMode(false));
  els.taskSearch.addEventListener("input", handleTaskSearchInput);
  els.taskSearchClearButton?.addEventListener("click", clearTaskSearch);
  els.taskFilterButton?.addEventListener("click", toggleTaskFilterPopover);
  els.taskFilterClearButton?.addEventListener("click", () => clearTaskFilters());
  document.addEventListener("keydown", handleTaskFilterKeydown);
  taskFilterControls().forEach((element: any) => {
    element.addEventListener("change", () => {
      updateTaskFilterSummary();
      renderTasks();
    });
  });
  updateTaskSearchClearButton();
  updateTaskFilterSummary();
  bindTaskListEvents();
}

function handleTaskSearchInput() {
  updateTaskSearchClearButton();
  renderTasks();
  void syncTaskSearchHistoryResults();
}

function replacementGroupKey(currentKey: string) {
  const query = taskSearchQuery();
  const groups = taskHistoryGroups(filteredVisibleTasks(query), query).filter((group: any) => taskGroupCount(group) > 0);
  const index = groups.findIndex((group: any) => String(group.key) === String(currentKey));
  return groups[index + 1]?.key || groups[index - 1]?.key || "";
}

function bindTaskListEvents() {
  const interactiveRoot = els.taskHistoryShell || els.sidebarContent || els.taskList;
  interactiveRoot?.addEventListener("click", handleTaskListClick);
  interactiveRoot?.addEventListener("keydown", handleTaskListKeydown);
  els.taskList?.addEventListener("pointerdown", handleTaskListPointerDown);
}

function taskHistoryInteractiveRoot() {
  return els.taskHistoryShell || els.sidebarContent || els.taskList;
}

function taskNavigationCards(): HTMLElement[] {
  const root = taskHistoryInteractiveRoot();
  if (!root) return [];
  return Array.from(root.querySelectorAll(".task-card[data-task-id]")) as HTMLElement[];
}

function focusTaskNavigationCard(card: HTMLElement): void {
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function isTaskListKeyboardInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button, input, select, textarea, a, [contenteditable='true'], [role='textbox']"));
}

function handleTaskCardArrowNavigation(card: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
  if (event.altKey || event.metaKey || event.ctrlKey || isTaskListKeyboardInputTarget(event.target)) return false;
  const cards = taskNavigationCards();
  const currentIndex = cards.indexOf(card);
  if (currentIndex < 0) return false;
  event.preventDefault();
  event.stopPropagation();
  const nextIndex = currentIndex + (event.key === "ArrowDown" ? 1 : -1);
  const nextCard = cards[nextIndex];
  if (!nextCard) return true;
  focusTaskNavigationCard(nextCard);
  if (!state.batchMode) {
    void legacyMethod("selectTask", nextCard.dataset.taskId);
  }
  return true;
}

function commitExpandedTaskGroupKey(nextKey: string | null, behavior: ScrollBehavior | null = null) {
  const previousLayout = captureTaskHistoryLayout();
  const changed = nextKey === null
    ? setExpandedTaskGroupKey(null, { immediate: true })
    : setExpandedTaskGroupKey(nextKey, { immediate: true });
  if (changed) {
    renderTasks();
    animateTaskHistoryLayout(previousLayout);
  }
  if (nextKey && behavior) {
    scrollExpandedTaskGroupToTop(behavior);
  }
}

function collapseExpandedTaskGroup(nextKey: string | null) {
  commitExpandedTaskGroupKey(nextKey);
}

function handleTaskListClick(event: any) {
  if (state.suppressTaskClickAfterDrag) {
    state.suppressTaskClickAfterDrag = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  const loadMoreButton = event.target.closest("[data-load-more-task-group]");
  if (loadMoreButton) {
    event.stopPropagation();
    void loadMoreSidebarTaskGroup(loadMoreButton.dataset.loadMoreTaskGroup);
    return;
  }

  const toggleButton = event.target.closest("[data-task-group-toggle-key]");
  if (toggleButton) {
    event.stopPropagation();
    const key = String(toggleButton.dataset.taskGroupToggleKey || "");
    if (toggleButton.classList.contains("task-group-header-split")) {
      collapseExpandedTaskGroup(null);
    } else {
      commitExpandedTaskGroupKey(key, "auto");
    }
    return;
  }

  const activeGroupToggle = event.target.closest("[data-active-task-group-toggle]");
  if (activeGroupToggle) {
    event.stopPropagation();
    const previousLayout = captureTaskHistoryLayout();
    state.activeTaskGroupCollapsed = !state.activeTaskGroupCollapsed;
    state.tasksRenderKey = null;
    renderTasks();
    animateTaskHistoryLayout(previousLayout);
    return;
  }

  const archiveButton = event.target.closest("[data-archive-task-id]");
  if (archiveButton) {
    event.stopPropagation();
    archiveTask(archiveButton.dataset.archiveTaskId);
    return;
  }

  const batchButton = event.target.closest("[data-batch-select-task-id]");
  if (batchButton) {
    event.stopPropagation();
    toggleBatchTaskSelection(batchButton.dataset.batchSelectTaskId);
    return;
  }

  const deleteButton = event.target.closest("[data-delete-task-id]");
  if (deleteButton) {
    event.stopPropagation();
    openTaskDeleteConfirm(deleteButton, deleteButton.dataset.deleteTaskId);
    return;
  }

  const card = event.target.closest(".task-card[data-task-id]");
  const root = taskHistoryInteractiveRoot();
  if (!card || !root?.contains(card)) return;
  if (handleBatchTaskShortcutSelection(card.dataset.taskId, event)) return;
  if (state.batchMode) {
    toggleBatchTaskSelection(card.dataset.taskId);
    return;
  }
  legacyMethod("selectTask", card.dataset.taskId);
}

function handleTaskListKeydown(event: any) {
  if (isTaskListKeyboardInputTarget(event.target)) return;
  const card = event.target.closest(".task-card[data-task-id]");
  const root = taskHistoryInteractiveRoot();
  if (!card || !root?.contains(card)) return;
  if (handleTaskCardArrowNavigation(card, event)) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  if (handleBatchTaskShortcutSelection(card.dataset.taskId, event)) return;
  if (state.batchMode) {
    toggleBatchTaskSelection(card.dataset.taskId);
  } else {
    legacyMethod("selectTask", card.dataset.taskId);
  }
}

export function initTaskListControlsFeature() {
  if (taskListControlsInitialized) return;
  taskListControlsInitialized = true;
  Object.assign(getLegacyBridge().methods, {
    updateTaskSearchClearButton,
    clearTaskSearch,
    updateTaskFilterSummary,
    setTaskFilterPopoverOpen,
    clearTaskFilters,
    bindTaskListControlEvents,
    bindTaskListEvents,
    handleTaskCardArrowNavigation,
    handleTaskListClick,
    handleTaskListKeydown,
  });
}
