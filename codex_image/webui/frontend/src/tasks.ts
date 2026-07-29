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

const updateTaskInState = (...args: any[]) => legacyMethod("updateTaskInState", ...args);
const cleanupSessionSelections = (...args: any[]) => legacyMethod("cleanupSessionSelections", ...args);
const renderTasks = (...args: any[]) => legacyMethod("renderTasks", ...args);
const renderArchiveButton = (...args: any[]) => legacyMethod("renderArchiveButton", ...args);
const renderArchiveModal = (...args: any[]) => legacyMethod("renderArchiveModal", ...args);
const renderPreview = (...args: any[]) => legacyMethod("renderPreview", ...args);
const migrateLegacyArchivedTasks = (...args: any[]) => legacyMethod("migrateLegacyArchivedTasks", ...args);
const revokeTaskUploadPreviewUrls = (...args: any[]) => legacyMethod("revokeTaskUploadPreviewUrls", ...args);
const taskHasViewableUpdate = (...args: any[]) => legacyMethod("taskHasViewableUpdate", ...args);
const markTaskViewed = (...args: any[]) => legacyMethod("markTaskViewed", ...args);
const ensureSelectedTaskDetail = (...args: any[]) => legacyMethod("ensureSelectedTaskDetail", ...args);
const TASK_SEARCH_HISTORY_LIMIT = 100;
const TASK_SEARCH_HISTORY_DEBOUNCE_MS = 180;
const TASK_SIDEBAR_GROUP_PAGE_SIZE = 50;
let taskSearchHistoryTimerId = 0;

function normalizedTaskSearchResultQuery(query: string): string {
  return String(query || "").trim().toLowerCase();
}

async function refreshTasks({ migrateLegacyArchives = false }: any = {}) {
  const requestSeq = ++state.tasksRequestSeq;
  const response = await fetch("/api/tasks/sidebar?limit=50");
  const data = await response.json();
  if (requestSeq !== state.tasksRequestSeq) return;
  await applyTasksSnapshot(data.tasks || [], {
    migrateLegacyArchives,
    requestSeq,
    taskGroups: data.task_groups,
  });
}

async function applyTasksSnapshot(
  tasks: any,
  {
    migrateLegacyArchives = false,
    requestSeq = state.tasksRequestSeq,
    taskGroups,
  }: any = {},
) {
  const previousLocalPendingTasks = state.tasks.filter((task: any) => task?.local_pending);
  const pendingTask = state.pendingTaskId ? state.tasks.find((task: any) => task.task_id === state.pendingTaskId) : null;
  state.tasks = mergeActiveQueueTaskDetails(Array.isArray(tasks) ? tasks : []);
  if (Array.isArray(taskGroups)) {
    state.taskSidebarGroupCounts = Object.fromEntries(
      taskGroups.map((group: any) => [String(group?.key || ""), Math.max(0, Number(group?.count || 0))]),
    );
    state.taskSidebarGroupLoadedCounts = Object.fromEntries(
      taskGroups.map((group: any) => [String(group?.key || ""), Array.isArray(group?.tasks) ? group.tasks.length : 0]),
    );
  }
  if (pendingTask?.local_pending && !state.tasks.some((task: any) => task.task_id === pendingTask.task_id)) {
    state.tasks.unshift(pendingTask);
  }
  const retainedTasks = new Set(state.tasks);
  previousLocalPendingTasks.forEach((task: any) => {
    if (!retainedTasks.has(task)) revokeTaskUploadPreviewUrls(task);
  });
  if (migrateLegacyArchives) {
    await migrateLegacyArchivedTasks();
    if (requestSeq !== state.tasksRequestSeq) return;
  }
  cleanupSessionSelections();
  renderTasks({ preserveScroll: true });
  renderArchiveButton();
  renderArchiveModal();
  await renderSelectedTaskPreview(requestSeq);
}

function mergeActiveQueueTaskDetails(tasks: any[]) {
  const activeTasks = [
    ...(Array.isArray(state.queue?.waiting) ? state.queue.waiting : []),
    ...(Array.isArray(state.queue?.running) ? state.queue.running : []),
  ];
  const activeById = new Map(
    activeTasks
      .filter((task: any) => task?.task_id)
      .map((task: any) => [String(task.task_id), task]),
  );
  const merged = tasks.map((task: any) => {
    const taskId = String(task?.task_id || "");
    const activeTask = activeById.get(taskId);
    if (!activeTask) return task;
    activeById.delete(taskId);
    return { ...task, ...activeTask, summary_only: false };
  });
  activeById.forEach((task: any) => {
    merged.push({ ...task, summary_only: false });
  });
  return merged;
}

async function loadMoreSidebarTaskGroup(groupKey: any) {
  const key = String(groupKey || "");
  if (!key || state.taskSidebarGroupLoading) return;
  const offset = Math.max(0, Number(state.taskSidebarGroupLoadedCounts?.[key] || 0));
  state.taskSidebarGroupLoading = key;
  state.tasksRenderKey = null;
  renderTasks({ preserveScroll: true });
  try {
    const response = await fetch(
      `/api/tasks/sidebar/groups/${encodeURIComponent(key)}?offset=${offset}&limit=${TASK_SIDEBAR_GROUP_PAGE_SIZE}`,
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Task group loading failed");
    const incoming = Array.isArray(data.tasks) ? data.tasks : [];
    const incomingById = new Map(incoming.map((task: any) => [String(task?.task_id || ""), task]));
    state.tasks = state.tasks.map((task: any) => incomingById.get(String(task?.task_id || "")) || task);
    const existingIds = new Set(state.tasks.map((task: any) => String(task?.task_id || "")));
    incoming.forEach((task: any) => {
      const taskId = String(task?.task_id || "");
      if (!taskId || existingIds.has(taskId)) return;
      state.tasks.push(task);
      existingIds.add(taskId);
    });
    state.taskSidebarGroupCounts[key] = Math.max(0, Number(data.count || 0));
    state.taskSidebarGroupLoadedCounts[key] = Math.max(offset, Number(data.next_offset || offset + incoming.length));
  } finally {
    state.taskSidebarGroupLoading = null;
    state.tasksRenderKey = null;
    renderTasks({ preserveScroll: true });
  }
}

async function refreshTasksAfterDeletion() {
  await refreshTasks();
}

async function applyTaskUpdate(task: any) {
  const previousTask = state.tasks.find((item: any) => String(item?.task_id || "") === String(task?.task_id || ""));
  const movedFromActiveToHistory = Boolean(
    previousTask
    && ["submitting", "queued", "running"].includes(String(previousTask.status || ""))
    && !["submitting", "queued", "running"].includes(String(task?.status || "")),
  );
  if (!updateTaskInState(task)) return;
  if (String(task.task_id) === String(state.selectedTaskId) && taskHasViewableUpdate(task)) {
    void markTaskViewed(task.task_id);
  }
  cleanupSessionSelections();
  renderTasks({ preserveScroll: true });
  renderArchiveButton();
  renderArchiveModal();
  await renderSelectedTaskPreview();
  if (movedFromActiveToHistory) {
    await refreshTasks();
  }
}

function currentTaskSearchQuery(): string {
  return String(els.taskSearch?.value || "").trim();
}

function activeOrSelectedTask(task: any): boolean {
  const taskId = String(task?.task_id || "");
  const status = String(task?.status || "");
  return Boolean(taskId && (
    String(state.selectedTaskId || "") === taskId
    || task?.local_pending
    || ["submitting", "queued", "running"].includes(status)
  ));
}

function historyTaskSummaryToSidebarTask(task: any) {
  const size = String(task.size || "");
  const promptFidelity = String(task.prompt_mode || "");
  const providerName = String(task.provider || "");
  return {
    task_id: String(task.task_id || ""),
    summary_only: true,
    created_at: String(task.created_at || ""),
    updated_at: String(task.updated_at || ""),
    completed_at: String(task.completed_at || ""),
    terminal_at: String(task.terminal_at || task.completed_at || ""),
    status: String(task.status || ""),
    mode: String(task.mode || ""),
    prompt: String(task.prompt_preview || task.task_id || ""),
    output_size: size,
    params: {
      size,
      n: Number(task.total_count || 1) || 1,
      prompt_fidelity: promptFidelity,
      api_provider_name: providerName,
    },
    backend: String(task.backend || ""),
    requested_backend: String(task.backend || ""),
    api_provider_name: providerName,
    generated_count: Number(task.generated_count || 0) || 0,
    failed_count: Number(task.failed_count || 0) || 0,
    total_count: Number(task.total_count || 1) || 1,
    thumbnail_urls: task.thumbnail_url ? [String(task.thumbnail_url)] : [],
  };
}

function mergeTaskSearchHistoryResults(tasks: any[], query: string) {
  const previousResultIds = new Set((state.taskSearchHistoryResultIds || []).map(String));
  const nextTasks = tasks.map(historyTaskSummaryToSidebarTask).filter((task) => task.task_id);
  const nextById = new Map(nextTasks.map((task) => [String(task.task_id), task]));
  const nextIds = new Set(nextById.keys());
  const merged: any[] = [];
  const seen = new Set<string>();
  state.tasks.forEach((task: any) => {
    const taskId = String(task?.task_id || "");
    if (!taskId) return;
    if (previousResultIds.has(taskId) && !nextIds.has(taskId) && !activeOrSelectedTask(task)) {
      return;
    }
    const replacement = nextById.get(taskId);
    if (replacement) {
      merged.push(task);
      seen.add(taskId);
      return;
    }
    merged.push(task);
  });
  nextTasks.forEach((task) => {
    if (seen.has(String(task.task_id))) return;
    merged.push(task);
  });
  state.tasks = merged;
  state.taskSearchHistoryResultIds = Array.from(nextIds);
  state.taskSearchHistoryResultQuery = normalizedTaskSearchResultQuery(query);
  state.tasksRenderKey = null;
}

function clearTaskSearchHistoryResults() {
  const previousResultIds = new Set((state.taskSearchHistoryResultIds || []).map(String));
  if (!previousResultIds.size) return;
  state.tasks = state.tasks.filter((task: any) => {
    const taskId = String(task?.task_id || "");
    return !previousResultIds.has(taskId) || activeOrSelectedTask(task);
  });
  state.taskSearchHistoryResultIds = [];
  state.taskSearchHistoryResultQuery = "";
  state.tasksRenderKey = null;
}

async function fetchTaskSearchHistoryResults(query: string, requestSeq: number) {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(TASK_SEARCH_HISTORY_LIMIT));
  params.set("archived", "false");
  const response = await fetch(`/api/task-history/tasks?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || "Task history search failed");
  if (requestSeq !== state.taskSearchHistoryRequestSeq || currentTaskSearchQuery() !== query) return;
  mergeTaskSearchHistoryResults(Array.isArray(data.tasks) ? data.tasks : [], query);
  renderTasks({ preserveScroll: true });
}

async function syncTaskSearchHistoryResults() {
  window.clearTimeout(taskSearchHistoryTimerId);
  const query = currentTaskSearchQuery();
  const requestSeq = ++state.taskSearchHistoryRequestSeq;
  if (!query) {
    clearTaskSearchHistoryResults();
    renderTasks({ preserveScroll: true });
    return;
  }
  taskSearchHistoryTimerId = window.setTimeout(() => {
    void fetchTaskSearchHistoryResults(query, requestSeq).catch((error) => {
      if (requestSeq !== state.taskSearchHistoryRequestSeq) return;
      console.warn(error);
    });
  }, TASK_SEARCH_HISTORY_DEBOUNCE_MS);
}

async function renderSelectedTaskPreview(requestSeq: number | null = null) {
  const selectedTask = state.tasks.find((item: any) => String(item.task_id) === String(state.selectedTaskId));
  if (selectedTask?.summary_only) {
    try {
      const detailedTask = await ensureSelectedTaskDetail(selectedTask.task_id);
      if (requestSeq !== null && requestSeq !== state.tasksRequestSeq) return;
      if (detailedTask) {
        renderPreview(detailedTask);
        return;
      }
    } catch (error) {
      console.warn(error);
      if (requestSeq !== null && requestSeq !== state.tasksRequestSeq) return;
    }
  }
  renderPreview();
}

export function initTaskFeature() {
  Object.assign(getLegacyBridge().methods, {
    refreshTasks,
    applyTasksSnapshot,
    applyTaskUpdate,
    loadMoreSidebarTaskGroup,
    refreshTasksAfterDeletion,
    syncTaskSearchHistoryResults,
  });
}
