import type { WebUITask } from "./types";

const USER_CANCELLATION_ERROR = "Task cancelled by user.";

export function taskWasCancelled(task: WebUITask | null | undefined): boolean {
  const error = String(task?.error || task?.last_error || "").trim();
  return Boolean(task?.cancel_requested || error === USER_CANCELLATION_ERROR);
}
