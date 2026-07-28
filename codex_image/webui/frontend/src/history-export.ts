export type HistoryExportMode =
  | "images_only"
  | "images_with_prompts";

export type HistoryExportResult = {
  export_id: string;
  download_url: string;
  filename: string;
  task_count: number;
  image_count: number;
};

export async function createHistoryExport(
  taskIds: string[],
  mode: HistoryExportMode,
): Promise<HistoryExportResult> {
  const response = await fetch("/api/task-history/exports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task_ids: taskIds,
      mode,
    }),
  });
  const payload = await response
    .json()
    .catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      typeof payload.detail === "string"
        ? payload.detail
        : "History export failed",
    );
  }
  return payload as HistoryExportResult;
}

export function triggerHistoryExportDownload(
  result: HistoryExportResult,
): void {
  const anchor = document.createElement("a");
  anchor.href = result.download_url;
  anchor.download = result.filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
