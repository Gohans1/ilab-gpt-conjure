import assert from "node:assert/strict";
import test from "node:test";

import {
  HISTORY_EXPLICIT_NAVIGATION_KEYS,
  HISTORY_FILTER_QUERY_KEYS,
  HISTORY_LOCATION_KEY,
  HISTORY_LOCATION_MAX_OFFSET,
  HISTORY_LOCATION_MAX_QUERY_LENGTH,
  HISTORY_ORGANIZER_QUERY_KEYS,
  clearHistoryLocationSnapshot,
  historySnapshotQuery,
  historyUrlHasExplicitNavigation,
  readHistoryLocationSnapshot,
  saveHistoryLocationSnapshot,
  type HistoryLocationSnapshot,
} from "../../codex_image/webui/frontend/src/history-scroll-memory.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  readonly removed: string[] = [];

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removed.push(key);
    this.values.delete(key);
  }
}

const snapshot: HistoryLocationSnapshot = {
  version: 1,
  query: "q=cat&sort=oldest&tag=a&tag=b",
  anchor: { taskId: "task-060", offset: 14 },
  savedAt: 123,
};

test("version 1 snapshot round trips under the fixed per-tab key", () => {
  const storage = new MemoryStorage();

  assert.equal(HISTORY_LOCATION_KEY, "ilab-conjure-history-location-v1");
  assert.equal(saveHistoryLocationSnapshot(snapshot, storage), true);
  assert.deepEqual(readHistoryLocationSnapshot(storage), snapshot);
  assert.equal(storage.values.size, 1);
  assert.ok(storage.values.has(HISTORY_LOCATION_KEY));

  assert.equal(clearHistoryLocationSnapshot(storage), true);
  assert.equal(readHistoryLocationSnapshot(storage), null);
});

test("snapshot validation rejects malformed values and clears invalid storage", () => {
  const invalidValues: unknown[] = [
    "not json",
    { ...snapshot, version: 2 },
    { ...snapshot, query: 42 },
    { ...snapshot, query: "q".repeat(HISTORY_LOCATION_MAX_QUERY_LENGTH + 1) },
    { ...snapshot, anchor: { ...snapshot.anchor, taskId: "   " } },
    { ...snapshot, anchor: { ...snapshot.anchor, taskId: 42 } },
    { ...snapshot, anchor: { ...snapshot.anchor, offset: "14" } },
    { ...snapshot, anchor: { ...snapshot.anchor, offset: null } },
    { ...snapshot, savedAt: "123" },
    { ...snapshot, savedAt: null },
  ];

  for (const value of invalidValues) {
    const storage = new MemoryStorage();
    storage.values.set(
      HISTORY_LOCATION_KEY,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    assert.equal(readHistoryLocationSnapshot(storage), null);
    assert.deepEqual(storage.removed, [HISTORY_LOCATION_KEY]);
  }
});

test("query and numeric boundaries are finite, bounded, and normalized", () => {
  const storage = new MemoryStorage();
  const boundary = {
    ...snapshot,
    query: "q".repeat(HISTORY_LOCATION_MAX_QUERY_LENGTH),
    anchor: {
      taskId: "  task-060  ",
      offset: HISTORY_LOCATION_MAX_OFFSET * 2,
    },
    savedAt: Number.MAX_SAFE_INTEGER,
  } satisfies HistoryLocationSnapshot;

  assert.equal(saveHistoryLocationSnapshot(boundary, storage), true);
  assert.deepEqual(readHistoryLocationSnapshot(storage), {
    ...boundary,
    anchor: {
      taskId: "task-060",
      offset: HISTORY_LOCATION_MAX_OFFSET,
    },
  });

  const negative = {
    ...boundary,
    anchor: { taskId: "task-060", offset: -HISTORY_LOCATION_MAX_OFFSET * 2 },
  };
  assert.equal(saveHistoryLocationSnapshot(negative, storage), true);
  assert.equal(
    readHistoryLocationSnapshot(storage)?.anchor.offset,
    -HISTORY_LOCATION_MAX_OFFSET,
  );

  for (const invalid of [
    { ...snapshot, anchor: { ...snapshot.anchor, offset: Number.NaN } },
    { ...snapshot, anchor: { ...snapshot.anchor, offset: Number.POSITIVE_INFINITY } },
    { ...snapshot, savedAt: Number.NaN },
    { ...snapshot, savedAt: Number.NEGATIVE_INFINITY },
  ]) {
    assert.equal(saveHistoryLocationSnapshot(invalid, storage), false);
  }
});

test("read write and remove failures are independently silent", () => {
  for (const error of [
    new DOMException("denied", "SecurityError"),
    new DOMException("full", "QuotaExceededError"),
  ]) {
    assert.equal(readHistoryLocationSnapshot({
      getItem: () => { throw error; },
      setItem: () => undefined,
      removeItem: () => undefined,
    }), null);
    assert.equal(saveHistoryLocationSnapshot(snapshot, {
      getItem: () => null,
      setItem: () => { throw error; },
      removeItem: () => undefined,
    }), false);
    assert.equal(clearHistoryLocationSnapshot({
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => { throw error; },
    }), false);
    assert.equal(readHistoryLocationSnapshot({
      getItem: () => "broken",
      setItem: () => undefined,
      removeItem: () => { throw error; },
    }), null);
  }
});

test("missing default window storage is a no-op", () => {
  assert.equal(readHistoryLocationSnapshot(), null);
  assert.equal(saveHistoryLocationSnapshot(snapshot), false);
  assert.equal(clearHistoryLocationSnapshot(), false);
});

test("throwing global sessionStorage getter is a safe no-op", () => {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  assert.ok(!original || original.configurable);
  const windowLike = {};
  Object.defineProperty(windowLike, "sessionStorage", {
    configurable: true,
    get: () => {
      throw new DOMException("denied", "SecurityError");
    },
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: windowLike,
  });
  try {
    assert.equal(readHistoryLocationSnapshot(), null);
    assert.equal(saveHistoryLocationSnapshot(snapshot), false);
    assert.equal(clearHistoryLocationSnapshot(), false);
  } finally {
    if (original) {
      Object.defineProperty(globalThis, "window", original);
    } else {
      delete globalWithWindow.window;
    }
  }
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(globalThis, "window"),
    original,
  );
});

test("snapshot query keeps only canonical history keys in stable order", () => {
  const params = new URLSearchParams();
  params.set("provider", "provider-even");
  params.append("tag", "tag-b");
  params.set("task", "task-detail");
  params.set("view", "grid");
  params.set("q", "cat photo");
  params.set("unrelated", "discard-me");
  params.set("sort", "newest");
  params.set("archived", "false");
  params.set("backend", "openai_images");
  params.set("orientation", "portrait");
  params.set("ratio", "9:16");
  params.set("quality", "high");
  params.set("prompt_mode", "strict");
  params.set("month", "2026-08");
  params.set("mode", "generate");
  params.set("favorite", "true");
  params.append("tag", "tag-a");
  params.set("untagged", "false");

  assert.equal(
    historySnapshotQuery(params),
    "q=cat+photo&mode=generate&month=2026-08"
      + "&prompt_mode=strict&quality=high&ratio=9%3A16&orientation=portrait"
      + "&backend=openai_images&provider=provider-even&archived=false"
      + "&favorite=true&tag=tag-b&tag=tag-a&untagged=false",
  );
  assert.equal(historySnapshotQuery(new URLSearchParams("q=cat")), "q=cat");
  assert.equal(historySnapshotQuery(new URLSearchParams("sort=oldest&view=list")), "sort=oldest&view=list");
  assert.equal(historySnapshotQuery(new URLSearchParams("sort=&view=")), "");
  assert.equal(historySnapshotQuery(new URLSearchParams("sort=unknown&view=cards")), "");
});

test("known navigation keys are explicit by presence, including empty values", () => {
  for (const key of HISTORY_EXPLICIT_NAVIGATION_KEYS) {
    assert.equal(
      historyUrlHasExplicitNavigation(new URLSearchParams(`${key}=`)),
      true,
      key,
    );
  }
  assert.equal(
    historyUrlHasExplicitNavigation(new URLSearchParams("unrelated=1")),
    false,
  );
  for (const query of [
    "sort=newest",
    "view=grid",
    "sort=unexpected",
    "view=unexpected",
  ]) {
    assert.equal(
      historyUrlHasExplicitNavigation(new URLSearchParams(query)),
      true,
      query,
    );
  }
  assert.equal(historyUrlHasExplicitNavigation(new URLSearchParams()), false);
});

test("memory filter keys stay aligned with history page URL filters", () => {
  assert.deepEqual([...HISTORY_FILTER_QUERY_KEYS], [
    "mode",
    "month",
    "prompt_mode",
    "quality",
    "ratio",
    "orientation",
    "backend",
    "provider",
    "archived",
  ]);
  assert.deepEqual([...HISTORY_ORGANIZER_QUERY_KEYS], [
    "favorite",
    "tag",
    "untagged",
  ]);
  assert.deepEqual([...HISTORY_EXPLICIT_NAVIGATION_KEYS], [
    "task",
    "q",
    "sort",
    "view",
    ...HISTORY_FILTER_QUERY_KEYS,
    ...HISTORY_ORGANIZER_QUERY_KEYS,
  ]);
});
