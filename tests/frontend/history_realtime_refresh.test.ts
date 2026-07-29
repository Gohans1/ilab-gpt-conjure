import assert from "node:assert/strict";
import test from "node:test";

import { refreshHistoryForRealtimeTask } from "../../codex_image/webui/frontend/src/history-realtime";

test("terminal task updates preserve a history window scrolled away from the top", async () => {
  const scroller = { scrollTop: 420 };
  const calls: string[] = [];

  await refreshHistoryForRealtimeTask({
    task: { task_id: "finished-task", status: "completed" },
    scroller,
    loadSummary: async () => {
      calls.push("summary");
    },
    reloadNewestWindow: async () => {
      calls.push("reload");
      scroller.scrollTop = 0;
    },
    upsertTask: (taskId) => {
      calls.push(`upsert:${taskId}`);
    },
  });

  assert.deepEqual(calls, ["upsert:finished-task", "summary"]);
  assert.equal(scroller.scrollTop, 420);
});

test("terminal task updates refresh the newest window when already at the top", async () => {
  const calls: string[] = [];

  await refreshHistoryForRealtimeTask({
    task: { task_id: "finished-task", status: "completed" },
    scroller: { scrollTop: 0 },
    loadSummary: async () => {
      calls.push("summary");
    },
    reloadNewestWindow: async () => {
      calls.push("reload");
    },
    upsertTask: (taskId) => {
      calls.push(`upsert:${taskId}`);
    },
  });

  assert.deepEqual(calls, ["upsert:finished-task", "summary", "reload"]);
});
