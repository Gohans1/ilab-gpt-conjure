import assert from "node:assert/strict";
import test from "node:test";

import {
  clearHistoryActiveFilters,
  collectHistoryActiveFilters,
  removeHistoryActiveFilter,
  type HistoryActiveFilterSnapshot,
} from "../../codex_image/webui/frontend/src/history-active-filters.ts";

const populated: HistoryActiveFilterSnapshot = {
  q: "portrait study",
  filters: {
    mode: "edit",
    month: "2026-04",
    prompt_mode: "strict",
    quality: "high",
    ratio: "9:16",
    orientation: "portrait",
    backend: "openai_images",
    provider: "provider-a",
    archived: "false",
  },
  organization: {
    favorite: true,
    tagIds: ["tag-a", "tag-b", "tag-a"],
    untagged: false,
  },
};

test("collects search, facet, favorite, and unique tag filters in stable order", () => {
  assert.deepEqual(
    collectHistoryActiveFilters(populated).map((item) => item.id),
    [
      "q",
      "filter:mode",
      "filter:month",
      "filter:prompt_mode",
      "filter:quality",
      "filter:ratio",
      "filter:orientation",
      "filter:backend",
      "filter:provider",
      "filter:archived",
      "favorite",
      "tag:tag-a",
      "tag:tag-b",
    ],
  );
});

test("removing one chip preserves every unrelated filter", () => {
  const month = collectHistoryActiveFilters(populated).find(
    (item) => item.id === "filter:month",
  );
  assert.ok(month);
  assert.deepEqual(removeHistoryActiveFilter(populated, month), {
    ...populated,
    filters: {
      ...populated.filters,
      month: "",
    },
  });

  const tag = collectHistoryActiveFilters(populated).find(
    (item) => item.id === "tag:tag-a",
  );
  assert.ok(tag);
  assert.deepEqual(removeHistoryActiveFilter(populated, tag), {
    ...populated,
    organization: {
      ...populated.organization,
      tagIds: ["tag-b"],
    },
  });
});

test("clear all removes search and every filter without carrying view state", () => {
  assert.deepEqual(clearHistoryActiveFilters(populated), {
    q: "",
    filters: {
      mode: "",
      month: "",
      prompt_mode: "",
      quality: "",
      ratio: "",
      orientation: "",
      backend: "",
      provider: "",
      archived: "",
    },
    organization: {
      favorite: false,
      tagIds: [],
      untagged: false,
    },
  });
});

test("untagged is represented instead of stale tag ids", () => {
  const snapshot: HistoryActiveFilterSnapshot = {
    q: "",
    filters: {},
    organization: {
      favorite: false,
      tagIds: ["stale-tag"],
      untagged: true,
    },
  };
  assert.deepEqual(
    collectHistoryActiveFilters(snapshot).map((item) => item.id),
    ["untagged"],
  );
});
