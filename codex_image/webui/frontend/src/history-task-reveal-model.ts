export type HistoryTaskRevealDestination =
  | { kind: "group"; groupKey: "today" | "yesterday" | "last7" }
  | { kind: "transient"; groupKey: "current" };

type HistoryTaskLike = {
  archived_at?: unknown;
  terminal_at?: unknown;
  completed_at?: unknown;
  created_at?: unknown;
};

type RevealDestinationOptions = {
  nowMs?: number;
  archived?: boolean;
};

type SidebarTaskRevealPagePlanInput = {
  targetIndex: number;
  targetLoaded: boolean;
  loadedCount: number;
  pageSize: number;
};

type HistoryTaskRevealLayoutState = {
  cardFound: boolean;
  groupRenderComplete: boolean;
  groupLayoutStable: boolean;
};

export function sidebarTaskDateBucket(
  task: HistoryTaskLike,
  nowMs: number = Date.now(),
): "today" | "yesterday" | "last7" | "older" {
  const rawTimestamp = task?.terminal_at || task?.completed_at || task?.created_at;
  const timestamp = Date.parse(String(rawTimestamp || ""));
  if (!Number.isFinite(timestamp)) return "older";
  const now = new Date(nowMs);
  const taskDate = new Date(timestamp);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const taskDayStart = new Date(taskDate.getFullYear(), taskDate.getMonth(), taskDate.getDate()).getTime();
  const dayDiff = Math.floor((todayStart - taskDayStart) / 86400000);
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "yesterday";
  if (dayDiff <= 6) return "last7";
  return "older";
}

export function historyTaskRevealDestination(
  task: HistoryTaskLike,
  options: RevealDestinationOptions = {},
): HistoryTaskRevealDestination {
  const archived = options.archived ?? Boolean(task?.archived_at);
  if (archived) return { kind: "transient", groupKey: "current" };
  const groupKey = sidebarTaskDateBucket(task, options.nowMs ?? Date.now());
  if (groupKey === "older") return { kind: "transient", groupKey: "current" };
  return { kind: "group", groupKey };
}

export function sidebarTaskRevealPagePlan(
  input: SidebarTaskRevealPagePlanInput,
): { found: boolean; targetIndex: number; offsets: number[] } {
  const targetIndex = Math.floor(Number(input.targetIndex));
  if (targetIndex < 0) return { found: false, targetIndex: -1, offsets: [] };
  if (input.targetLoaded) {
    return { found: true, targetIndex, offsets: [] };
  }
  const pageSize = Math.max(1, Math.floor(Number(input.pageSize) || 1));
  const loadedCount = Math.max(0, Math.floor(Number(input.loadedCount) || 0));
  const firstOffset = targetIndex < loadedCount
    ? Math.floor(targetIndex / pageSize) * pageSize
    : loadedCount;
  const offsets: number[] = [];
  for (let offset = firstOffset; offset <= targetIndex; offset += pageSize) {
    offsets.push(offset);
  }
  return { found: true, targetIndex, offsets };
}

export function historyTaskRevealLayoutReady(
  state: HistoryTaskRevealLayoutState,
): boolean {
  return Boolean(
    state.cardFound
    && state.groupRenderComplete
    && state.groupLayoutStable
  );
}
