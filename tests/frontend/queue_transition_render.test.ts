import assert from "node:assert/strict";
import test from "node:test";

test("waiting-to-running queue updates render one consistent task-card state", async () => {
  const waitingTask = {
    task_id: "waiting-to-running",
    prompt: "queue transition",
    status: "queued",
    created_at: "2026-07-29T00:00:00Z",
    updated_at: "2026-07-29T00:00:00Z",
    total_count: 1,
  };
  const runningTask = {
    ...waitingTask,
    status: "running",
    started_at: "2026-07-29T00:00:01Z",
    updated_at: "2026-07-29T00:00:01Z",
    channel_id: "codex:0",
  };
  const state: any = {
    tasks: [waitingTask],
    selectedTaskId: null,
    queue: {
      waiting: [{ ...waitingTask, queue_position: 1 }],
      running: [],
      summary: {
        waiting_count: 1,
        running_count: 0,
        channel_count: 1,
        usable_channel_count: 1,
      },
    },
    queueRequestSeq: 0,
    queueDispatchSyncTimerId: null,
    queueRenderKey: null,
  };
  const renderedStates: Array<{ status: string; waiting: string[]; running: string[] }> = [];
  const bridge: any = {
    state,
    els: {},
    constants: { defaultDocumentTitle: "iLab CONJURE" },
    boot() {},
    methods: {
      cleanupSessionSelections() {},
      markTaskViewed() {},
      notifyTaskUpdate() {},
      renderArchiveButton() {},
      renderArchiveModal() {},
      renderPreview() {},
      renderTasks() {
        renderedStates.push({
          status: String(state.tasks[0]?.status || ""),
          waiting: state.queue.waiting.map((task: any) => String(task.task_id)),
          running: state.queue.running.map((task: any) => String(task.task_id)),
        });
      },
      setStatus() {},
      taskHasViewableUpdate() {
        return false;
      },
      updateDocumentTitle() {},
      updateTaskInState(task: any) {
        const index = state.tasks.findIndex((item: any) => String(item.task_id) === String(task.task_id));
        if (index < 0) state.tasks.unshift(task);
        else state.tasks[index] = task;
        return true;
      },
    },
  };
  (globalThis as any).window = {
    __codexImageWebUI: bridge,
    clearTimeout,
    setTimeout,
  };

  const { handleRealtimePayload } = await import(
    "../../codex_image/webui/frontend/src/queue"
  );
  await handleRealtimePayload({
    type: "queue",
    queue: {
      waiting: [],
      running: [runningTask],
      summary: {
        waiting_count: 0,
        running_count: 1,
        channel_count: 1,
        usable_channel_count: 1,
      },
    },
  } as any);

  assert.deepEqual(renderedStates, [
    {
      status: "running",
      waiting: [],
      running: ["waiting-to-running"],
    },
  ]);
});
