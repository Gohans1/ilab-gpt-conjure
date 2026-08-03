import assert from "node:assert/strict";
import test from "node:test";

import {
  isCompleteProviderOrder,
  moveProviderId,
} from "../../codex_image/webui/frontend/src/api-provider-sort";

test("moves providers forward, backward, and to both ends", () => {
  assert.deepEqual(moveProviderId(["a", "b", "c", "d"], "b", 3), ["a", "c", "d", "b"]);
  assert.deepEqual(moveProviderId(["a", "b", "c", "d"], "d", 1), ["a", "d", "b", "c"]);
  assert.deepEqual(moveProviderId(["a", "b", "c"], "b", 0), ["b", "a", "c"]);
  assert.deepEqual(moveProviderId(["a", "b", "c"], "b", 99), ["a", "c", "b"]);
});

test("keeps same-position and unknown-provider moves unchanged", () => {
  assert.deepEqual(moveProviderId(["a", "b", "c"], "b", 1), ["a", "b", "c"]);
  assert.deepEqual(moveProviderId(["a", "b", "c"], "x", 0), ["a", "b", "c"]);
});

test("accepts only a complete unique permutation", () => {
  assert.equal(isCompleteProviderOrder(["c", "a", "b"], ["a", "b", "c"]), true);
  assert.equal(isCompleteProviderOrder(["a", "a", "c"], ["a", "b", "c"]), false);
  assert.equal(isCompleteProviderOrder(["a", "b"], ["a", "b", "c"]), false);
  assert.equal(isCompleteProviderOrder(["a", "b", "x"], ["a", "b", "c"]), false);
});
