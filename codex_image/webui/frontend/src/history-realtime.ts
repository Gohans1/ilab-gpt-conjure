import type { WebUITask } from "./types";

const HISTORY_REALTIME_TOP_THRESHOLD = 8;

export async function refreshHistoryForRealtimeTask({
  task,
  scroller,
  loadSummary,
  reloadNewestWindow,
  upsertTask,
}: {
  task: WebUITask | null | undefined;
  scroller?: Pick<HTMLElement, "scrollTop"> | null;
  loadSummary: () => Promise<void>;
  reloadNewestWindow: () => Promise<void>;
  upsertTask: (taskId: string, task: WebUITask) => void;
}): Promise<void> {
  const preserveCurrentWindow = Boolean(
    scroller && scroller.scrollTop > HISTORY_REALTIME_TOP_THRESHOLD,
  );
  const taskId = String(task?.task_id || "");
  if (task && taskId) upsertTask(taskId, task);
  await loadSummary();
  if (!preserveCurrentWindow) {
    await reloadNewestWindow();
  }
}
