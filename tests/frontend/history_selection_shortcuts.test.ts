import assert from "node:assert/strict";
import test from "node:test";

import {
  historySelectAllTaskIds,
  isHistorySelectAllTasksShortcut,
} from "../../codex_image/webui/frontend/src/history-selection-shortcuts";

const passiveTarget = { closest: () => null };
const editableTarget = { closest: () => ({}) };

test("Ctrl+A and Command+A select history tasks outside editable controls", () => {
  assert.equal(isHistorySelectAllTasksShortcut({ key: "a", ctrlKey: true }, passiveTarget), true);
  assert.equal(isHistorySelectAllTasksShortcut({ key: "A", metaKey: true }, passiveTarget), true);
  assert.equal(isHistorySelectAllTasksShortcut({ key: "a", ctrlKey: true }, editableTarget), false);
  assert.equal(isHistorySelectAllTasksShortcut({ key: "a", ctrlKey: true, altKey: true }, passiveTarget), false);
  assert.equal(isHistorySelectAllTasksShortcut({ key: "a" }, passiveTarget), false);
});

test("select-all keeps the rendered task order and removes empty or duplicate ids", () => {
  assert.deepEqual(historySelectAllTaskIds(["task-2", "", "task-1", "task-2"]), ["task-2", "task-1"]);
});
