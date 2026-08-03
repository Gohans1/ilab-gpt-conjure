import assert from "node:assert/strict";
import test from "node:test";

import {
  type HistoryLocationSnapshot,
} from "../../codex_image/webui/frontend/src/history-scroll-memory.ts";
import {
  createHistoryPositionSaveController,
} from "../../codex_image/webui/frontend/src/history-window.ts";
import {
  historyTaskPageQuery,
  loadHistoryAnchorPage,
  runHistoryPositionBoot,
  type HistoryPageQueryInput,
} from "../../codex_image/webui/frontend/src/history-position-runtime.ts";

const snapshot: HistoryLocationSnapshot = {
  version: 1,
  query: "q=cat&sort=oldest&mode=generate&provider=provider-even&tag=a&tag=b",
  anchor: { taskId: "task-060", offset: 14 },
  savedAt: 123,
};

const queryInput = (overrides: Partial<HistoryPageQueryInput> = {}): HistoryPageQueryInput => ({
  limit: 50,
  sort: "oldest",
  q: "cat",
  filters: {
    mode: "generate",
    provider: "provider-even",
  },
  organization: {
    favorite: false,
    tagIds: ["a", "b"],
    untagged: false,
  },
  ...overrides,
});

async function boundedOutcome(
  pending: Promise<unknown>,
): Promise<{ status: "resolved" | "rejected" | "timeout"; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), 25);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("default boot applies query before sync and makes one real anchor request", async () => {
  const events: string[] = [];
  const requestUrls: string[] = [];
  let currentSearch = "";
  let synced = new URLSearchParams();

  const result = await runHistoryPositionBoot({
    params: new URLSearchParams(),
    pathname: "/history",
    snapshot,
    replaceLocation: (url) => {
      events.push("replace");
      currentSearch = new URL(url, "http://history.local").search;
    },
    syncLocation: () => {
      events.push("sync");
      synced = new URLSearchParams(currentSearch);
    },
    clearSnapshot: () => events.push("clear"),
    loadPage: async (options) => {
      assert.equal(options.anchorTaskId, "task-060");
      return loadHistoryAnchorPage({
        query: queryInput({
          sort: synced.get("sort") ?? "newest",
          q: synced.get("q") ?? "",
          filters: {
            mode: synced.get("mode") ?? "",
            provider: synced.get("provider") ?? "",
          },
          anchorTaskId: options.anchorTaskId,
        }),
        anchor: options.anchor ?? null,
        request: async (url) => {
          events.push("request");
          requestUrls.push(url);
          return {
            tasks: [{ task_id: "task-060" }],
            previous_cursor: "previous",
            next_cursor: "next",
            anchor_found: true,
          };
        },
        isCurrent: () => true,
        render: () => events.push("render"),
        applyCursors: () => events.push("cursors"),
        requestFrame: (callback) => {
          events.push("raf");
          callback();
          return 1;
        },
        restore: () => events.push("restore"),
        enableSave: () => events.push("enable"),
      });
    },
  });

  assert.deepEqual(result, { anchorFound: true, taskCount: 1 });
  assert.deepEqual(events.slice(0, 3), ["replace", "sync", "request"]);
  assert.equal(requestUrls.length, 1);
  const requestUrl = new URL(requestUrls[0] ?? "", "http://history.local");
  assert.equal(requestUrl.pathname, "/api/task-history/tasks");
  assert.equal(requestUrl.searchParams.get("anchor_task_id"), "task-060");
  assert.equal(requestUrl.searchParams.get("q"), "cat");
  assert.equal(requestUrl.searchParams.get("mode"), "generate");
  assert.equal(requestUrl.searchParams.get("provider"), "provider-even");
  assert.deepEqual(requestUrl.searchParams.getAll("tag"), ["a", "b"]);
  assert.equal(requestUrl.searchParams.has("cursor"), false);
  assert.equal(requestUrl.searchParams.has("direction"), false);
});

test("explicit URL syncs unchanged and makes one ordinary request", async () => {
  const events: string[] = [];
  const requestUrls: string[] = [];
  await runHistoryPositionBoot({
    params: new URLSearchParams("q=dog"),
    pathname: "/history",
    snapshot,
    replaceLocation: () => assert.fail("explicit URL must not be replaced"),
    syncLocation: () => events.push("sync"),
    clearSnapshot: () => assert.fail("explicit URL must not clear the snapshot"),
    loadPage: async (options) => {
      assert.deepEqual(options, { reset: true });
      events.push("request");
      requestUrls.push(`/api/task-history/tasks?${historyTaskPageQuery(queryInput({
        sort: "newest",
        q: "dog",
      }))}`);
      return { anchorFound: null, taskCount: 50 };
    },
  });
  assert.deepEqual(events, ["sync", "request"]);
  assert.equal(requestUrls.length, 1);
  const params = new URL(requestUrls[0] ?? "", "http://history.local").searchParams;
  assert.equal(params.get("q"), "dog");
  assert.equal(params.has("anchor_task_id"), false);
});

test("missing anchor has no partial commit and performs one cleared fallback", async () => {
  const events: string[] = [];
  const requestUrls: string[] = [];
  await runHistoryPositionBoot({
    params: new URLSearchParams(),
    pathname: "/history",
    snapshot,
    replaceLocation: () => events.push("replace"),
    syncLocation: () => events.push("sync"),
    clearSnapshot: () => events.push("clear"),
    loadPage: async (options) => {
      if (!options.anchorTaskId) {
        events.push("fallback-request");
        requestUrls.push(`/api/task-history/tasks?${historyTaskPageQuery(queryInput())}`);
        events.push("fallback-render");
        return { anchorFound: null, taskCount: 50 };
      }
      return loadHistoryAnchorPage({
        query: queryInput({ anchorTaskId: options.anchorTaskId }),
        anchor: options.anchor ?? null,
        request: async (url) => {
          events.push("anchor-request");
          requestUrls.push(url);
          return {
            tasks: [], previous_cursor: null, next_cursor: null,
            anchor_found: false,
          };
        },
        isCurrent: () => true,
        render: () => events.push("anchor-render"),
        applyCursors: () => events.push("anchor-cursors"),
        requestFrame: () => assert.fail("missing anchor must not schedule a frame"),
        restore: () => events.push("anchor-restore"),
        enableSave: () => events.push("anchor-enable"),
      });
    },
  });

  assert.equal(requestUrls.length, 2);
  assert.equal(events.filter((event) => event === "clear").length, 1);
  assert.equal(events.filter((event) => event === "fallback-request").length, 1);
  assert.equal(events.filter((event) => event === "fallback-render").length, 1);
  assert.equal(events.some((event) => event.startsWith("anchor-") && event !== "anchor-request"), false);
});

test("anchor commit is all-or-nothing at each currentness checkpoint", async () => {
  for (const staleAt of [1, 2, 3]) {
    const effects: string[] = [];
    let checks = 0;
    const result = await loadHistoryAnchorPage({
      query: queryInput({ anchorTaskId: "task-060" }),
      anchor: snapshot.anchor,
      request: async () => ({
        tasks: [{ task_id: "task-060" }], previous_cursor: "p", next_cursor: "n",
        anchor_found: true,
      }),
      isCurrent: () => {
        checks += 1;
        return checks !== staleAt;
      },
      render: () => effects.push("render"),
      applyCursors: () => effects.push("cursors"),
      requestFrame: () => { effects.push("raf"); return 1; },
      restore: () => effects.push("restore"),
      enableSave: () => effects.push("enable"),
    });
    assert.deepEqual(result, { anchorFound: null, taskCount: 0 }, `checkpoint ${staleAt}`);
    assert.deepEqual(effects, [], `checkpoint ${staleAt}`);
  }

  const effects: string[] = [];
  const frames: Array<() => void> = [];
  let active = true;
  const pending = loadHistoryAnchorPage({
    query: queryInput({ anchorTaskId: "task-060" }),
    anchor: snapshot.anchor,
    request: async () => ({
      tasks: [{ task_id: "task-060" }], previous_cursor: "p", next_cursor: "n",
      anchor_found: true,
    }),
    isCurrent: () => active,
    render: () => effects.push("render"),
    applyCursors: () => effects.push("cursors"),
    requestFrame: (callback) => { frames.push(callback); return 1; },
    restore: () => effects.push("restore"),
    enableSave: () => effects.push("enable"),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  active = false;
  frames[0]?.();
  assert.deepEqual(await pending, { anchorFound: null, taskCount: 0 });
  assert.deepEqual(effects, []);
});

test("successful anchor commit renders and applies once, then restores before enabling", async () => {
  const effects: string[] = [];
  const frames: Array<() => void> = [];
  const pending = loadHistoryAnchorPage({
    query: queryInput({ anchorTaskId: "task-060" }),
    anchor: snapshot.anchor,
    request: async (url) => {
      effects.push(`request:${url}`);
      return {
        tasks: [{ task_id: "task-060" }], previous_cursor: "p", next_cursor: "n",
        anchor_found: true,
      };
    },
    isCurrent: () => true,
    render: (tasks) => effects.push(`render:${tasks.length}`),
    applyCursors: (previous, next) => effects.push(`cursors:${previous}:${next}`),
    requestFrame: (callback) => { frames.push(callback); return 1; },
    restore: (anchor) => effects.push(`restore:${anchor?.taskId}:${anchor?.offset}`),
    enableSave: () => effects.push("enable"),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(frames.length, 1);
  assert.equal(effects.some((effect) => effect.startsWith("render")), false);
  frames[0]?.();
  assert.deepEqual(await pending, { anchorFound: true, taskCount: 1 });
  assert.deepEqual(effects.slice(1), [
    "render:1",
    "cursors:p:n",
    "restore:task-060:14",
    "enable",
  ]);
});

test("request errors and aborts preserve existing error handling", async () => {
  for (const error of [
    new Error("offline"),
    new DOMException("aborted", "AbortError"),
  ]) {
    const effects: string[] = [];
    await assert.rejects(loadHistoryAnchorPage({
      query: queryInput({ anchorTaskId: "task-060" }),
      anchor: snapshot.anchor,
      request: async () => { throw error; },
      isCurrent: () => true,
      render: () => effects.push("render"),
      applyCursors: () => effects.push("cursors"),
      requestFrame: () => { effects.push("raf"); return 1; },
      restore: () => effects.push("restore"),
      enableSave: () => effects.push("enable"),
    }), error);
    assert.deepEqual(effects, []);
  }
});

test("each synchronous commit-stage error rejects instead of leaving the load pending", async () => {
  for (const failingStage of ["render", "cursors", "restore", "enable"] as const) {
    const error = new Error(`${failingStage} failed`);
    const effects: string[] = [];
    const frames: Array<() => void> = [];
    const stage = (name: typeof failingStage): void => {
      effects.push(name);
      if (name === failingStage) throw error;
    };
    const pending = loadHistoryAnchorPage({
      query: queryInput({ anchorTaskId: "task-060" }),
      anchor: snapshot.anchor,
      request: async () => ({
        tasks: [{ task_id: "task-060" }], previous_cursor: "p", next_cursor: "n",
        anchor_found: true,
      }),
      isCurrent: () => true,
      render: () => stage("render"),
      applyCursors: () => stage("cursors"),
      requestFrame: (callback) => { frames.push(callback); return 1; },
      restore: () => stage("restore"),
      enableSave: () => stage("enable"),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let callbackError: unknown;
    try {
      frames[0]?.();
    } catch (caught) {
      callbackError = caught;
    }
    const outcome = await boundedOutcome(pending);
    assert.deepEqual(
      outcome,
      { status: "rejected", error },
      `${failingStage} must settle the outer promise`,
    );
    assert.equal(callbackError, undefined, `${failingStage} must reject, not escape the frame`);
    assert.deepEqual(
      effects,
      ["render", "cursors", "restore", "enable"].slice(
        0,
        ["render", "cursors", "restore", "enable"].indexOf(failingStage) + 1,
      ),
    );
  }
});

test("a synchronous requestFrame error rejects the anchor load", async () => {
  const error = new Error("requestFrame failed");
  const pending = loadHistoryAnchorPage({
    query: queryInput({ anchorTaskId: "task-060" }),
    anchor: snapshot.anchor,
    request: async () => ({
      tasks: [{ task_id: "task-060" }], previous_cursor: "p", next_cursor: "n",
      anchor_found: true,
    }),
    isCurrent: () => true,
    render: () => assert.fail("requestFrame failed before commit"),
    applyCursors: () => assert.fail("requestFrame failed before commit"),
    requestFrame: () => { throw error; },
    restore: () => assert.fail("requestFrame failed before commit"),
    enableSave: () => assert.fail("requestFrame failed before commit"),
  });
  assert.deepEqual(await boundedOutcome(pending), { status: "rejected", error });
});

test("scroll saves at most once per frame and pagehide flushes the latest anchor", () => {
  const frames = new Map<number, () => void>();
  const cancelled: number[] = [];
  const saved: Array<{ taskId: string; offset: number }> = [];
  let nextFrame = 1;
  let anchor = { taskId: "task-060", offset: 14 };
  let captures = 0;
  let renders = 0;
  const controller = createHistoryPositionSaveController({
    requestFrame: (callback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => {
      cancelled.push(id);
      frames.delete(id);
    },
    capture: () => {
      captures += 1;
      return anchor;
    },
    save: (value) => saved.push(value),
  });

  controller.schedule();
  controller.flush();
  assert.equal(captures, 0, "saving stays disabled during initial restore");
  controller.enable();
  controller.schedule();
  controller.schedule();
  controller.schedule();
  assert.equal(frames.size, 1);
  frames.get(1)?.();
  frames.delete(1);
  assert.equal(captures, 1);
  assert.deepEqual(saved, [{ taskId: "task-060", offset: 14 }]);
  assert.equal(renders, 0);

  anchor = { taskId: "task-061", offset: -8 };
  controller.schedule();
  controller.flush();
  assert.deepEqual(cancelled, [2]);
  assert.deepEqual(saved.at(-1), anchor);
  assert.equal(frames.size, 0);
});

test("empty task list never overwrites the last valid snapshot", () => {
  const saved = [{ taskId: "task-old", offset: 7 }];
  const frames: Array<() => void> = [];
  const controller = createHistoryPositionSaveController({
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => undefined,
    capture: () => null,
    save: (value) => saved.push(value),
  });
  controller.enable();
  controller.schedule();
  frames[0]?.();
  controller.flush();

  assert.deepEqual(saved, [{ taskId: "task-old", offset: 7 }]);
});
