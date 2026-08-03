type HistoryShortcutEvent = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

type ClosestTarget = {
  closest?: (selector: string) => unknown;
} | null;

const HISTORY_SHORTCUT_EDITABLE_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(", ");

export function isHistorySelectAllTasksShortcut(
  event: HistoryShortcutEvent,
  target: ClosestTarget,
): boolean {
  if (event.key.toLowerCase() !== "a") return false;
  if ((!event.ctrlKey && !event.metaKey) || event.shiftKey || event.altKey) return false;
  return !target?.closest?.(HISTORY_SHORTCUT_EDITABLE_SELECTOR);
}

export function historySelectAllTaskIds(taskIds: string[]): string[] {
  return [...new Set(taskIds.map((taskId) => String(taskId || "")).filter(Boolean))];
}
