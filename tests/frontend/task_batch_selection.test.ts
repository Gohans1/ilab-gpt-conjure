import assert from "node:assert/strict";
import test from "node:test";

import { waitingBatchTaskIds } from "../../codex_image/webui/frontend/src/task-batch-selection-model";

test("waiting batch selection includes only valid waiting queue tasks", () => {
  assert.deepEqual(
    waitingBatchTaskIds({
      running: [
        { task_id: "running-1" },
      ],
      waiting: [
        { task_id: "waiting-1" },
        { task_id: "waiting-2" },
        { task_id: "waiting-1" },
        { task_id: "" },
        null,
      ],
    }),
    ["waiting-1", "waiting-2"],
  );
});

test("waiting batch selection is empty when no waiting tasks exist", () => {
  assert.deepEqual(waitingBatchTaskIds({ running: [{ task_id: "running-1" }] }), []);
  assert.deepEqual(waitingBatchTaskIds(null), []);
});
