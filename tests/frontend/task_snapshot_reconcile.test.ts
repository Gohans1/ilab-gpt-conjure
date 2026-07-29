import assert from "node:assert/strict";
import test from "node:test";

test("sidebar refresh keeps detailed output-slot states from the active queue", async () => {
  const activeTask = {
    task_id: "running-multi",
    status: "running",
    total_count: 2,
    generated_count: 0,
    failed_count: 0,
    outputs: [
      { index: 1, status: "running" },
      { index: 2, status: "running" },
    ],
  };
  const sidebarSummary = {
    task_id: "running-multi",
    summary_only: true,
    status: "running",
    total_count: 2,
    generated_count: 0,
    failed_count: 0,
  };
  const state: any = {
    tasks: [],
    queue: {
      waiting: [],
      running: [activeTask],
      summary: {
        waiting_count: 0,
        running_count: 1,
        channel_count: 2,
      },
    },
    tasksRequestSeq: 1,
    pendingTaskId: null,
    selectedTaskId: null,
  };
  const bridge: any = {
    state,
    els: {},
    constants: { defaultDocumentTitle: "iLab CONJURE" },
    boot() {},
    methods: {
      cleanupSessionSelections() {},
      renderTasks() {},
      renderArchiveButton() {},
      renderArchiveModal() {},
      renderPreview() {},
      revokeTaskUploadPreviewUrls() {},
    },
  };
  (globalThis as any).window = { __codexImageWebUI: bridge };

  const { initTaskFeature } = await import(
    "../../codex_image/webui/frontend/src/tasks"
  );
  initTaskFeature();
  await bridge.methods.applyTasksSnapshot(
    [sidebarSummary],
    { requestSeq: 1 },
  );

  assert.deepEqual(
    state.tasks[0]?.outputs?.map((record: any) => record.status),
    ["running", "running"],
  );
  assert.equal(state.tasks[0]?.summary_only, false);
});
