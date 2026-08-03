import assert from "node:assert/strict";
import test from "node:test";

import {
  HistoryBackupApiError,
  cancelHistoryBackup,
  createHistoryBackup,
  createHistoryBackupController,
  directDownloadHistoryBackup,
  estimateHistoryBackup,
  getHistoryBackup,
  historyBackupViewState,
  readStoredHistoryBackupJobId,
  type HistoryBackupFilters,
} from "../../codex_image/webui/frontend/src/history-backup.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const filters: HistoryBackupFilters = {
  q: "rabbit", month: "2026-08", mode: "generate", status: "completed",
  prompt_mode: "strict", size: "1024x1024", quality: "high", ratio: "1:1",
  orientation: "square", backend: "api", provider: "openai",
  archived: false, favorite: null, tag_ids: ["tag-a"], untagged: false,
  sort: "oldest",
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("backup scopes send only their discriminated payload fields", async () => {
  const bodies: any[] = [];
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return json({ job_id: "a".repeat(32), status: "queued" });
  };

  await createHistoryBackup({ kind: "selected", taskIds: ["one", "two"] }, { fetch: fetchFn });
  await createHistoryBackup({ kind: "filtered", filters }, { fetch: fetchFn });
  await createHistoryBackup({ kind: "all" }, { fetch: fetchFn });

  assert.deepEqual(bodies, [
    { scope: "selected", task_ids: ["one", "two"] },
    { scope: "filtered", filters },
    { scope: "all" },
  ]);
});

test("backup estimates reuse the exact scope payload without creating a job", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchFn = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body)),
    });
    return json({ scope: "filtered", total_tasks: 8, eligible_tasks: 6, excluded_nonterminal: 2 });
  };

  const estimate = await estimateHistoryBackup({ kind: "filtered", filters }, { fetch: fetchFn });

  assert.deepEqual(estimate, {
    scope: "filtered", total_tasks: 8, eligible_tasks: 6, excluded_nonterminal: 2,
  });
  assert.deepEqual(calls, [{
    url: "/api/task-history/backup-exports/estimate",
    method: "POST",
    body: { scope: "filtered", filters },
  }]);
});

test("backup view state locks submitted scope and uses stage-accurate progress", () => {
  assert.deepEqual(historyBackupViewState(null), {
    active: false,
    ready: false,
    dismissible: false,
    scopeLocked: false,
    progressMode: "hidden",
    progressValue: 0,
  });
  assert.equal(historyBackupViewState({ job_id: "a".repeat(32), status: "queued" }).scopeLocked, true);
  assert.equal(historyBackupViewState({ job_id: "a".repeat(32), status: "planning" }).progressMode, "indeterminate");
  assert.deepEqual(historyBackupViewState({
    job_id: "a".repeat(32), status: "packing", total_bytes: 200, completed_bytes: 50,
  }), {
    active: true,
    ready: false,
    dismissible: false,
    scopeLocked: true,
    progressMode: "determinate",
    progressValue: 25,
  });
  assert.equal(historyBackupViewState({ job_id: "a".repeat(32), status: "ready" }).progressMode, "hidden");
  assert.equal(historyBackupViewState({ job_id: "a".repeat(32), status: "ready" }).scopeLocked, true);
  assert.equal(historyBackupViewState({ job_id: "a".repeat(32), status: "failed" }).scopeLocked, false);
});

test("controller restores the frozen scope kind with a resumable job", async () => {
  const storage = new MemoryStorage();
  const jobId = "d".repeat(32);
  const first = createHistoryBackupController({
    storage,
    fetch: async () => json({ job_id: jobId, status: "ready", download_url: "/download" }),
  });

  const created = await first.start({ kind: "all" });
  assert.equal(created.scope_kind, "all");

  const refreshed = createHistoryBackupController({
    storage,
    fetch: async () => json({ job_id: jobId, status: "ready", download_url: "/download" }),
  });
  const resumed = await refreshed.resume();
  assert.equal(resumed?.scope_kind, "all");
});

test("typed get/cancel parse stable API errors without leaking unknown bodies", async () => {
  const calls: Array<[string, string]> = [];
  const fetchFn = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push([String(url), init?.method ?? "GET"]);
    if (init?.method === "DELETE") return json({ job_id: "a".repeat(32), status: "cancelled" });
    return json({ detail: { code: "backup_export_not_found", message: "safe" } }, 404);
  };
  await assert.rejects(
    getHistoryBackup("a".repeat(32), { fetch: fetchFn }),
    (error: unknown) => error instanceof HistoryBackupApiError
      && error.code === "backup_export_not_found" && error.status === 404,
  );
  await cancelHistoryBackup("a".repeat(32), { fetch: fetchFn });
  const secretFetch = async () => json({
    detail: { code: "backup_internal_error", message: "secret_prompt /private/request.json" },
  }, 500);
  await assert.rejects(
    getHistoryBackup("b".repeat(32), { fetch: secretFetch }),
    (error: unknown) => error instanceof HistoryBackupApiError
      && error.code === "backup_internal_error"
      && !error.message.includes("secret_prompt"),
  );
  assert.equal(calls[1]?.[1], "DELETE");
});

test("direct download clicks a hidden anchor and never fetches a blob", () => {
  let clicked = 0;
  let removed = 0;
  const anchor: any = { href: "", hidden: false, click: () => { clicked += 1; }, remove: () => { removed += 1; } };
  const documentLike: any = {
    createElement(tag: string) { assert.equal(tag, "a"); return anchor; },
    body: { appendChild(value: unknown) { assert.equal(value, anchor); } },
  };
  directDownloadHistoryBackup("/api/task-history/backup-exports/id/download", documentLike);
  assert.equal(anchor.hidden, true);
  assert.equal(anchor.href, "/api/task-history/backup-exports/id/download");
  assert.equal(clicked, 1);
  assert.equal(removed, 1);
});

test("controller uses one backoff timer, stops at terminal, and stores only versioned job id", async () => {
  const storage = new MemoryStorage();
  const timers: Array<{ callback: () => Promise<void>; delay: number; active: boolean }> = [];
  const setTimeoutFn = (callback: () => void, delay: number) => {
    const item = {
      callback: async () => { item.active = false; await callback(); },
      delay,
      active: true,
    };
    timers.push(item);
    return item;
  };
  const clearTimeoutFn = (handle: any) => { handle.active = false; };
  const pollStatuses = ["planning", "ready"];
  const observed: string[] = [];
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit) => json({
    job_id: "c".repeat(32),
    status: init?.method === "POST" ? "queued" : pollStatuses.shift(),
    download_url: pollStatuses.length ? null : "/download",
  });
  const controller = createHistoryBackupController({
    fetch: fetchFn,
    storage,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    onStatus: (job) => observed.push(job.status),
  });

  await controller.start({ kind: "all" });
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId: "c".repeat(32) }));
  assert.deepEqual(timers.filter((item) => item.active).map((item) => item.delay), [750]);
  await timers[0]?.callback();
  assert.equal(timers.filter((item) => item.active).length, 1);
  assert.equal(timers.at(-1)?.delay, 1125);
  await timers.at(-1)?.callback();
  assert.deepEqual(observed, ["queued", "planning", "ready"]);
  assert.equal(timers.filter((item) => item.active).length, 0);
  assert.equal(controller.activeJobId(), "c".repeat(32));
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId: "c".repeat(32) }));
});

test("ready job remains resumable across controller refresh", async () => {
  const storage = new MemoryStorage();
  const jobId = "e".repeat(32);
  const first = createHistoryBackupController({
    fetch: async () => json({ job_id: jobId, status: "ready", download_url: "/download" }),
    storage,
  });
  await first.start({ kind: "all" });
  assert.equal(first.activeJobId(), jobId);

  const calls: string[] = [];
  const refreshed = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      return json({ job_id: jobId, status: "ready", download_url: "/download" });
    },
    storage,
    setTimeout: () => { throw new Error("ready must not schedule another poll"); },
  });
  assert.equal((await refreshed.resume())?.status, "ready");
  assert.deepEqual(calls, [`GET /api/task-history/backup-exports/${jobId}`]);
  assert.equal(refreshed.activeJobId(), jobId);
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId }));
});

test("failed and interrupted remain resumable while cancelled and expired are forgotten", async () => {
  const cases = [
    ["failed", "a"], ["interrupted", "b"], ["cancelled", "c"], ["expired", "d"],
  ] as const;
  for (const [status, idDigit] of cases) {
    const storage = new MemoryStorage();
    const jobId = idDigit.repeat(32);
    storage.setItem("ilab-history-backup-job", JSON.stringify({ version: 1, jobId }));
    const controller = createHistoryBackupController({
      fetch: async () => json({ job_id: jobId, status }),
      storage,
      setTimeout: () => { throw new Error("terminal status must not poll"); },
    });
    await controller.resume();
    const retained = status === "failed" || status === "interrupted";
    assert.equal(controller.activeJobId(), retained ? jobId : null, status);
    assert.equal(storage.getItem("ilab-history-backup-job"), retained
      ? JSON.stringify({ version: 1, jobId })
      : null, status);
  }
});

test("acknowledge only clears the matching local job and sends no DELETE", async () => {
  const storage = new MemoryStorage();
  const jobId = "6".repeat(32);
  const calls: string[] = [];
  const timers: Array<{ active: boolean }> = [];
  const controller = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      return json({ job_id: jobId, status: "queued" });
    },
    storage,
    setTimeout: () => { const timer = { active: true }; timers.push(timer); return timer; },
    clearTimeout: (timer: any) => { timer.active = false; },
  });
  await controller.start({ kind: "all" });

  assert.equal(controller.acknowledge("7".repeat(32)), false);
  assert.equal(controller.activeJobId(), jobId);
  assert.equal(timers[0]?.active, true);
  assert.equal(controller.acknowledge(jobId), true);
  assert.equal(controller.activeJobId(), null);
  assert.equal(storage.getItem("ilab-history-backup-job"), null);
  assert.equal(timers[0]?.active, false);
  assert.equal(calls.some((call) => call.startsWith("DELETE")), false);
});

test("dismiss deletes an unclaimed ready result before clearing local state", async () => {
  const storage = new MemoryStorage();
  const jobId = "a".repeat(32);
  const calls: string[] = [];
  const controller = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      if (init.method === "DELETE") {
        return json({ job_id: jobId, status: "expired" });
      }
      return json({ job_id: jobId, status: "ready", download_url: "/download" });
    },
    storage,
  });
  await controller.start({ kind: "all" });

  assert.equal(await controller.dismiss(jobId), true);
  assert.equal(controller.activeJobId(), null);
  assert.equal(storage.getItem("ilab-history-backup-job"), null);
  assert.deepEqual(calls, [
    "POST /api/task-history/backup-exports",
    `DELETE /api/task-history/backup-exports/${jobId}`,
  ]);
});

test("dismiss preserves a ready result when server cleanup fails", async () => {
  const storage = new MemoryStorage();
  const jobId = "b".repeat(32);
  const controller = createHistoryBackupController({
    fetch: async (_url, init = {}) => init.method === "DELETE"
      ? json({ detail: { code: "backup_internal_error", message: "safe" } }, 500)
      : json({ job_id: jobId, status: "ready", download_url: "/download" }),
    storage,
  });
  await controller.start({ kind: "all" });

  await assert.rejects(
    controller.dismiss(jobId),
    (error: unknown) => error instanceof HistoryBackupApiError && error.status === 500,
  );
  assert.equal(controller.activeJobId(), jobId);
  assert.equal(readStoredHistoryBackupJobId(storage), jobId);
});

test("ready download acknowledges only after a successful matching anchor click", async () => {
  const storage = new MemoryStorage();
  const jobId = "7".repeat(32);
  let clicked = 0;
  let removed = 0;
  const controller = createHistoryBackupController({
    fetch: async () => json({ job_id: jobId, status: "ready", download_url: "/download" }),
    storage,
    document: {
      createElement: () => ({
        href: "", hidden: false,
        click: () => { clicked += 1; },
        remove: () => { removed += 1; },
      }),
      body: { appendChild: () => undefined },
    },
  });
  const job = await controller.start({ kind: "all" });
  controller.download(job);

  assert.equal(clicked, 1);
  assert.equal(removed, 1);
  assert.equal(controller.activeJobId(), null);
  assert.equal(storage.getItem("ilab-history-backup-job"), null);
});

test("download fails closed for invalid jobs and preserves state when anchor click throws", async () => {
  const storage = new MemoryStorage();
  const jobId = "8".repeat(32);
  let removed = 0;
  const controller = createHistoryBackupController({
    fetch: async () => json({ job_id: jobId, status: "ready", download_url: "/download" }),
    storage,
    document: {
      createElement: () => ({
        href: "", hidden: false,
        click: () => { throw new Error("download blocked"); },
        remove: () => { removed += 1; },
      }),
      body: { appendChild: () => undefined },
    },
  });
  const job = await controller.start({ kind: "all" });

  assert.throws(
    () => controller.download({ ...job, job_id: "9".repeat(32) }),
    (error: unknown) => error instanceof HistoryBackupApiError && error.code === "backup_download_job_mismatch",
  );
  assert.throws(
    () => controller.download({ ...job, status: "packing" }),
    (error: unknown) => error instanceof HistoryBackupApiError && error.code === "backup_download_not_ready",
  );
  assert.throws(
    () => controller.download({ ...job, download_url: null }),
    (error: unknown) => error instanceof HistoryBackupApiError && error.code === "backup_download_unavailable",
  );
  assert.throws(() => controller.download(job), /download blocked/);

  assert.equal(removed, 1);
  assert.equal(controller.activeJobId(), jobId);
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId }));
});

test("controller aborts an active poll and ignores corrupt or old stored state", async () => {
  const storage = new MemoryStorage();
  storage.setItem("ilab-history-backup-job", "not-json");
  assert.equal(readStoredHistoryBackupJobId(storage), null);
  storage.setItem("ilab-history-backup-job", JSON.stringify({ version: 2, jobId: "secret" }));
  assert.equal(readStoredHistoryBackupJobId(storage), null);

  let activeSignal: AbortSignal | undefined;
  let rejectPoll: ((reason?: unknown) => void) | undefined;
  const timers: Array<() => void> = [];
  const fetchFn = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") return json({ job_id: "d".repeat(32), status: "queued" });
    activeSignal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => { rejectPoll = reject; });
  };
  const controller = createHistoryBackupController({
    fetch: fetchFn,
    storage,
    setTimeout: (callback) => { timers.push(callback); return callback; },
    clearTimeout: () => {},
  });
  await controller.start({ kind: "all" });
  const polling = timers[0]?.();
  await Promise.resolve();
  controller.dispose();
  assert.equal(activeSignal?.aborted, true);
  rejectPoll?.(new DOMException("aborted", "AbortError"));
  await polling;
});

test("superseded create cannot revive state and its server job is deleted", async () => {
  const storage = new MemoryStorage();
  const first = deferred<Response>();
  const calls: string[] = [];
  let postCount = 0;
  const timers: Array<() => void> = [];
  const observed: string[] = [];
  const fetchFn = async (url: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push(`${init.method ?? "GET"} ${String(url)}`);
    if (init.method === "DELETE") return json({ job_id: String(url).split("/").at(-1), status: "cancelled" });
    postCount += 1;
    if (postCount === 1) return first.promise;
    return json({ job_id: "2".repeat(32), status: "queued" });
  };
  const controller = createHistoryBackupController({
    fetch: fetchFn, storage,
    setTimeout: (callback) => { timers.push(callback); return callback; },
    clearTimeout: () => {},
    onStatus: (job) => observed.push(job.job_id),
  });
  const stale = controller.start({ kind: "all" });
  const staleRejected = assert.rejects(stale, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  const current = await controller.start({ kind: "selected", taskIds: ["task-2"] });
  first.resolve(json({ job_id: "1".repeat(32), status: "queued" }));
  await staleRejected;

  assert.equal(current.job_id, "2".repeat(32));
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId: "2".repeat(32) }));
  assert.deepEqual(observed, ["2".repeat(32)]);
  assert.equal(calls.includes(`DELETE /api/task-history/backup-exports/${"1".repeat(32)}`), true);
  assert.equal(timers.length, 1);
});

test("stale backup create with the current job id is not deleted", async () => {
  const storage = new MemoryStorage();
  const first = deferred<Response>();
  const sharedId = "6".repeat(32);
  const calls: string[] = [];
  let postCount = 0;
  const controller = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      if (init.method === "DELETE") return json({ job_id: sharedId, status: "cancelled" });
      postCount += 1;
      return postCount === 1 ? first.promise : json({ job_id: sharedId, status: "ready" });
    },
    storage,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });

  const stale = controller.start({ kind: "all" });
  const staleRejected = assert.rejects(stale, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  await controller.start({ kind: "selected", taskIds: ["current"] });
  first.resolve(json({ job_id: sharedId, status: "queued" }));
  await staleRejected;

  assert.equal(calls.some((call) => call.startsWith("DELETE")), false);
  assert.equal(controller.activeJobId(), sharedId);
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId: sharedId }));
});

test("adopted backup id survives terminal and a no-op cancel before stale create cleanup", async () => {
  const storage = new MemoryStorage();
  const first = deferred<Response>();
  const sharedId = "d".repeat(32);
  const calls: string[] = [];
  let postCount = 0;
  const controller = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      if (init.method === "DELETE") return json({ job_id: sharedId, status: "cancelled" });
      postCount += 1;
      return postCount === 1 ? first.promise : json({ job_id: sharedId, status: "ready" });
    },
    storage,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });

  const stale = controller.start({ kind: "all" });
  const staleRejected = assert.rejects(stale, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  await controller.start({ kind: "selected", taskIds: ["current"] });
  assert.equal(controller.acknowledge(sharedId), true);
  assert.equal(await controller.cancel(), null);
  first.resolve(json({ job_id: sharedId, status: "queued" }));
  await staleRejected;

  assert.equal(calls.some((call) => call.startsWith("DELETE")), false);
  assert.equal(controller.activeJobId(), null);
  assert.equal(storage.getItem("ilab-history-backup-job"), null);
});

test("dispose makes a late backup create reject AbortError after exact cleanup", async () => {
  const pending = deferred<Response>();
  const orphanId = "7".repeat(32);
  const calls: string[] = [];
  const statuses: string[] = [];
  const errors: string[] = [];
  const controller = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      if (init.method === "DELETE") return json({ job_id: orphanId, status: "cancelled" });
      return pending.promise;
    },
    storage: new MemoryStorage(),
    onStatus: (job) => statuses.push(job.status),
    onError: (error) => errors.push(error.code),
  });
  const stale = controller.start({ kind: "all" });
  await Promise.resolve();
  controller.dispose();
  pending.resolve(json({ job_id: orphanId, status: "queued" }));

  await assert.rejects(stale, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  assert.equal(calls.includes(`DELETE /api/task-history/backup-exports/${orphanId}`), true);
  assert.deepEqual(statuses, []);
  assert.deepEqual(errors, []);
});

test("backup restart retires one stored id before concurrent replacement create", async () => {
  const storage = new MemoryStorage();
  const retiredId = "8".repeat(32);
  storage.setItem("ilab-history-backup-job", JSON.stringify({ version: 1, jobId: retiredId }));
  const pendingDelete = deferred<Response>();
  const calls: string[] = [];
  const controller = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      if (init.method === "DELETE") return pendingDelete.promise;
      return json({ job_id: retiredId, status: "queued" });
    },
    storage,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });

  const superseded = controller.start({ kind: "all" });
  const current = controller.start({ kind: "selected", taskIds: ["current"] });
  await Promise.resolve();
  assert.deepEqual(calls, [`DELETE /api/task-history/backup-exports/${retiredId}`]);
  assert.equal(storage.getItem("ilab-history-backup-job"), null);

  pendingDelete.resolve(json({ job_id: retiredId, status: "cancelled" }));
  await assert.rejects(superseded, (error: unknown) => (
    error instanceof DOMException && error.name === "AbortError"
  ));
  const replacement = await current;

  assert.equal(calls.filter((call) => call.startsWith("DELETE")).length, 1);
  assert.equal(calls.filter((call) => call.startsWith("POST")).length, 1);
  assert.equal(replacement.job_id, retiredId);
  assert.equal(controller.activeJobId(), retiredId);
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId: retiredId }));
});

test("backup restart retires its active id and continues cleanly after DELETE failure", async () => {
  const storage = new MemoryStorage();
  const oldId = "b".repeat(32);
  const newId = "c".repeat(32);
  const calls: string[] = [];
  const errors: string[] = [];
  let postCount = 0;
  const controller = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      if (init.method === "DELETE") {
        return json({ detail: { code: "backup_busy", message: "backup_busy" } }, 503);
      }
      postCount += 1;
      return json({ job_id: postCount === 1 ? oldId : newId, status: "queued" });
    },
    storage,
    setTimeout: () => ({}),
    clearTimeout: () => {},
    onError: (error) => errors.push(error.code),
  });

  await controller.start({ kind: "all" });
  const replacement = await controller.start({ kind: "selected", taskIds: ["replacement"] });

  assert.deepEqual(calls.slice(0, 3), [
    "POST /api/task-history/backup-exports",
    `DELETE /api/task-history/backup-exports/${oldId}`,
    "POST /api/task-history/backup-exports",
  ]);
  assert.equal(replacement.job_id, newId);
  assert.equal(controller.activeJobId(), newId);
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId: newId }));
  assert.deepEqual(errors, []);
});

test("backup cancel delete remains authoritative while a replacement start waits", async () => {
  const storage = new MemoryStorage();
  const oldId = "9".repeat(32);
  const newId = "a".repeat(32);
  const pendingDelete = deferred<Response>();
  const calls: string[] = [];
  let postCount = 0;
  const controller = createHistoryBackupController({
    fetch: async (url, init = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(url)}`);
      if (init.method === "DELETE") return pendingDelete.promise;
      postCount += 1;
      return json({ job_id: postCount === 1 ? oldId : newId, status: "queued" });
    },
    storage,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });
  await controller.start({ kind: "all" });
  const cancelled = controller.cancel();
  const restarted = controller.start({ kind: "all" });
  await Promise.resolve();
  assert.equal(postCount, 1);

  pendingDelete.resolve(json({ job_id: oldId, status: "cancelled" }));
  assert.equal((await cancelled)?.job_id, oldId);
  assert.equal((await restarted).job_id, newId);
  assert.equal(calls.filter((call) => call.startsWith("DELETE")).length, 1);
  assert.equal(controller.activeJobId(), newId);
});

test("asynchronous backup cancellation keeps polling until the server reaches cancelled", async () => {
  const storage = new MemoryStorage();
  const jobId = "c".repeat(32);
  const timers: Array<{ callback: () => Promise<void>; active: boolean }> = [];
  const observed: string[] = [];
  const controller = createHistoryBackupController({
    fetch: async (_url, init = {}) => {
      if (init.method === "POST") return json({ job_id: jobId, status: "packing" });
      if (init.method === "DELETE") return json({ job_id: jobId, status: "packing" });
      return json({ job_id: jobId, status: "cancelled" });
    },
    storage,
    setTimeout: (callback) => {
      const item = {
        callback: async () => { item.active = false; await callback(); },
        active: true,
      };
      timers.push(item);
      return item;
    },
    clearTimeout: (item: any) => { item.active = false; },
    onStatus: (job) => observed.push(job.status),
  });

  await controller.start({ kind: "all" });
  const pending = await controller.cancel();

  assert.equal(pending?.status, "packing");
  assert.equal(controller.activeJobId(), jobId);
  assert.equal(readStoredHistoryBackupJobId(storage), jobId);
  assert.equal(timers.filter((item) => item.active).length, 1);

  await timers.find((item) => item.active)!.callback();

  assert.deepEqual(observed, ["packing", "packing", "cancelled"]);
  assert.equal(controller.activeJobId(), null);
  assert.equal(readStoredHistoryBackupJobId(storage), null);
});

test("late poll rejection after cancel cannot report, schedule, or restore storage", async () => {
  const storage = new MemoryStorage();
  const pendingPoll = deferred<Response>();
  const timers: Array<{ callback: () => void; active: boolean }> = [];
  const errors: string[] = [];
  const observed: string[] = [];
  const fetchFn = async (url: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.method === "POST") return json({ job_id: "3".repeat(32), status: "queued" });
    if (init.method === "DELETE") return json({ job_id: "3".repeat(32), status: "cancelled" });
    return pendingPoll.promise;
  };
  const controller = createHistoryBackupController({
    fetch: fetchFn, storage,
    setTimeout: (callback) => {
      const item = { callback: () => { item.active = false; callback(); }, active: true };
      timers.push(item);
      return item;
    },
    clearTimeout: (item: any) => { item.active = false; },
    onStatus: (job) => observed.push(job.status),
    onError: (error) => errors.push(error.code),
  });
  await controller.start({ kind: "all" });
  timers[0]?.callback();
  await Promise.resolve();
  await controller.cancel();
  pendingPoll.reject(new TypeError("late network error"));
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(observed, ["queued", "cancelled"]);
  assert.deepEqual(errors, []);
  assert.equal(storage.getItem("ilab-history-backup-job"), null);
  assert.equal(timers.filter((item) => item.active).length, 0);
  assert.equal(controller.activeJobId(), null);
});

test("current transient poll error reports once and continues backoff to terminal", async () => {
  const storage = new MemoryStorage();
  const timers: Array<{ callback: () => Promise<void>; delay: number; active: boolean }> = [];
  let getCount = 0;
  const errors: string[] = [];
  const fetchFn = async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.method === "POST") return json({ job_id: "4".repeat(32), status: "queued" });
    getCount += 1;
    if (getCount === 1) throw new TypeError("temporary offline");
    return json({ job_id: "4".repeat(32), status: "ready", download_url: "/download" });
  };
  const controller = createHistoryBackupController({
    fetch: fetchFn, storage,
    setTimeout: (callback, delay) => {
      const item = { callback: async () => { item.active = false; await callback(); }, delay, active: true };
      timers.push(item); return item;
    },
    clearTimeout: (item: any) => { item.active = false; },
    onError: (error) => errors.push(error.code),
  });
  await controller.start({ kind: "all" });
  await timers[0]?.callback();
  assert.deepEqual(errors, ["backup_network_error"]);
  assert.equal(timers.filter((item) => item.active).length, 1);
  assert.equal(timers.at(-1)?.delay, 1125);
  await timers.at(-1)?.callback();
  assert.equal(storage.getItem("ilab-history-backup-job"), JSON.stringify({ version: 1, jobId: "4".repeat(32) }));
  assert.equal(controller.activeJobId(), "4".repeat(32));
  assert.equal(timers.filter((item) => item.active).length, 0);
});

test("non-retryable poll 404 stops and clears the current job", async () => {
  const storage = new MemoryStorage();
  const timers: Array<() => Promise<void>> = [];
  const errors: string[] = [];
  const fetchFn = async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    if (init.method === "POST") return json({ job_id: "5".repeat(32), status: "queued" });
    return json({ detail: { code: "backup_export_not_found", message: "backup_export_not_found" } }, 404);
  };
  const controller = createHistoryBackupController({
    fetch: fetchFn, storage,
    setTimeout: (callback) => { const run = async () => { await callback(); }; timers.push(run); return run; },
    clearTimeout: () => {},
    onError: (error) => errors.push(error.code),
  });
  await controller.start({ kind: "all" });
  await timers[0]?.();

  assert.deepEqual(errors, ["backup_export_not_found"]);
  assert.equal(timers.length, 1);
  assert.equal(storage.getItem("ilab-history-backup-job"), null);
  assert.equal(controller.activeJobId(), null);
});
