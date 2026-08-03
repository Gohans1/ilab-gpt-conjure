export function waitingBatchTaskIds(queue: any): string[] {
  const taskIds = (queue?.waiting || [])
    .map((task: any) => String(task?.task_id || ""))
    .filter(Boolean);
  return Array.from(new Set(taskIds));
}
