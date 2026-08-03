export type BackupJobStatus =
  | "queued"
  | "planning"
  | "packing"
  | "ready"
  | "failed"
  | "cancelled"
  | "expired"
  | "interrupted";

export interface HistoryBackupFilters {
  q: string;
  month: string;
  mode: string;
  status: string;
  prompt_mode: string;
  size: string;
  quality: string;
  ratio: string;
  orientation: string;
  backend: string;
  provider: string;
  archived: boolean | null;
  favorite: boolean | null;
  tag_ids: string[];
  untagged: boolean;
  sort: "newest" | "oldest";
}

export type HistoryBackupScope =
  | { kind: "selected"; taskIds: string[] }
  | { kind: "filtered"; filters: HistoryBackupFilters }
  | { kind: "all" };

export interface HistoryBackupJob {
  job_id: string;
  status: BackupJobStatus;
  scope_kind?: HistoryBackupScope["kind"];
  created_at?: string;
  updated_at?: string;
  total_tasks?: number;
  eligible_tasks?: number;
  excluded_nonterminal?: number;
  completed_tasks?: number;
  total_bytes?: number;
  completed_bytes?: number;
  tasks_with_missing_inputs?: number;
  missing_input_files?: number;
  filename?: string | null;
  download_url?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface HistoryBackupEstimate {
  scope: HistoryBackupScope["kind"];
  total_tasks: number;
  eligible_tasks: number;
  excluded_nonterminal: number;
}

export interface HistoryBackupViewState {
  active: boolean;
  ready: boolean;
  dismissible: boolean;
  scopeLocked: boolean;
  progressMode: "hidden" | "indeterminate" | "determinate";
  progressValue: number;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type TimerHandle = unknown;
type SetTimeoutLike = (callback: () => void, delay: number) => TimerHandle;
type ClearTimeoutLike = (handle: TimerHandle) => void;
type AnchorLike = {
  href: string;
  hidden: boolean;
  click(): void;
  remove(): void;
};
type DocumentLike = {
  createElement(tag: "a"): AnchorLike;
  body?: { appendChild(node: AnchorLike): unknown } | null;
};

export interface HistoryBackupRequestOptions {
  fetch?: FetchLike;
  signal?: AbortSignal | undefined;
}

export interface HistoryBackupControllerOptions {
  fetch?: FetchLike;
  storage?: StorageLike | null;
  setTimeout?: SetTimeoutLike;
  clearTimeout?: ClearTimeoutLike;
  document?: DocumentLike | null;
  onStatus?: (job: HistoryBackupJob) => void;
  onError?: (error: HistoryBackupApiError) => void;
}

export const HISTORY_BACKUP_STORAGE_KEY = "ilab-history-backup-job";
export const HISTORY_BACKUP_SCOPE_STORAGE_KEY = "ilab-history-backup-scope";
const TERMINAL_STATUSES = new Set<BackupJobStatus>([
  "ready", "failed", "cancelled", "expired", "interrupted",
]);
const FORGET_STATUSES = new Set<BackupJobStatus>(["cancelled", "expired"]);

export function historyBackupViewState(job: HistoryBackupJob | null): HistoryBackupViewState {
  const active = Boolean(job && ["queued", "planning", "packing"].includes(job.status));
  const ready = job?.status === "ready";
  const packing = job?.status === "packing";
  const totalBytes = Number(job?.total_bytes || 0);
  const completedBytes = Number(job?.completed_bytes || 0);
  return {
    active,
    ready,
    dismissible: Boolean(job && ["ready", "failed", "interrupted"].includes(job.status)),
    scopeLocked: active || ready,
    progressMode: packing
      ? "determinate"
      : job && ["queued", "planning"].includes(job.status)
        ? "indeterminate"
        : "hidden",
    progressValue: packing && totalBytes > 0
      ? Math.min(100, Math.round(completedBytes * 100 / totalBytes))
      : 0,
  };
}

export class HistoryBackupApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "HistoryBackupApiError";
    this.code = code;
    this.status = status;
  }
}

function currentFetch(): FetchLike {
  const value = globalThis.fetch;
  if (typeof value !== "function") throw new Error("history_backup_fetch_unavailable");
  return value.bind(globalThis);
}

function currentStorage(): StorageLike | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function currentDocument(): DocumentLike | null {
  try {
    return typeof document === "undefined" ? null : document as unknown as DocumentLike;
  } catch {
    return null;
  }
}

function defaultSetTimeout(callback: () => void, delay: number): TimerHandle {
  return globalThis.setTimeout(callback, delay);
}

function defaultClearTimeout(handle: TimerHandle): void {
  globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
}

async function apiError(response: Response): Promise<HistoryBackupApiError> {
  let code = "backup_request_failed";
  let message = code;
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object") {
      const detail = (payload as Record<string, unknown>).detail;
      if (detail && typeof detail === "object") {
        const record = detail as Record<string, unknown>;
        if (typeof record.code === "string" && /^[a-z][a-z0-9_]{2,127}$/.test(record.code)) {
          code = record.code;
          message = typeof record.message === "string" && record.message === code
            ? record.message
            : code;
        }
      }
    }
  } catch {
    // Unknown bodies are intentionally not copied into the public error.
  }
  return new HistoryBackupApiError(code, message, response.status);
}

async function requestJson<T>(
  url: string,
  init: RequestInit,
  fetchFn: FetchLike,
): Promise<T> {
  const response = await fetchFn(url, init);
  if (!response.ok) throw await apiError(response);
  return await response.json() as T;
}

function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal ? { ...init, signal } : init;
}

function scopePayload(scope: HistoryBackupScope): Record<string, unknown> {
  if (scope.kind === "selected") {
    return { scope: "selected", task_ids: [...scope.taskIds] };
  }
  if (scope.kind === "filtered") {
    return { scope: "filtered", filters: { ...scope.filters, tag_ids: [...scope.filters.tag_ids] } };
  }
  return { scope: "all" };
}

export async function createHistoryBackup(
  scope: HistoryBackupScope,
  options: HistoryBackupRequestOptions = {},
): Promise<HistoryBackupJob> {
  return requestJson<HistoryBackupJob>(
    "/api/task-history/backup-exports",
    withSignal({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scopePayload(scope)),
    }, options.signal),
    options.fetch ?? currentFetch(),
  );
}

export async function estimateHistoryBackup(
  scope: HistoryBackupScope,
  options: HistoryBackupRequestOptions = {},
): Promise<HistoryBackupEstimate> {
  return requestJson<HistoryBackupEstimate>(
    "/api/task-history/backup-exports/estimate",
    withSignal({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(scopePayload(scope)),
    }, options.signal),
    options.fetch ?? currentFetch(),
  );
}

export async function getHistoryBackup(
  jobId: string,
  options: HistoryBackupRequestOptions = {},
): Promise<HistoryBackupJob> {
  return requestJson<HistoryBackupJob>(
    `/api/task-history/backup-exports/${encodeURIComponent(jobId)}`,
    withSignal({ method: "GET" }, options.signal),
    options.fetch ?? currentFetch(),
  );
}

export async function cancelHistoryBackup(
  jobId: string,
  options: HistoryBackupRequestOptions = {},
): Promise<HistoryBackupJob> {
  return requestJson<HistoryBackupJob>(
    `/api/task-history/backup-exports/${encodeURIComponent(jobId)}`,
    withSignal({ method: "DELETE" }, options.signal),
    options.fetch ?? currentFetch(),
  );
}

export function directDownloadHistoryBackup(
  downloadUrl: string,
  documentLike: DocumentLike | null = currentDocument(),
): void {
  if (!documentLike) throw new Error("history_backup_document_unavailable");
  const anchor = documentLike.createElement("a");
  anchor.href = downloadUrl;
  anchor.hidden = true;
  documentLike.body?.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

export function readStoredHistoryBackupJobId(
  storage: StorageLike | null = currentStorage(),
): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(HISTORY_BACKUP_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed && typeof parsed === "object"
      && Object.keys(parsed).length === 2
      && (parsed as Record<string, unknown>).version === 1
      && typeof (parsed as Record<string, unknown>).jobId === "string"
      && /^[0-9a-f]{32}$/.test((parsed as { jobId: string }).jobId)
    ) {
      return (parsed as { jobId: string }).jobId;
    }
  } catch {
    // Invalid state is removed below.
  }
  try { storage.removeItem(HISTORY_BACKUP_STORAGE_KEY); } catch { /* ignored */ }
  return null;
}

function storeJobId(storage: StorageLike | null, jobId: string): void {
  if (!storage) return;
  try {
    storage.setItem(HISTORY_BACKUP_STORAGE_KEY, JSON.stringify({ version: 1, jobId }));
  } catch {
    // The in-memory controller remains usable when storage is unavailable.
  }
}

function readStoredScopeKind(storage: StorageLike | null): HistoryBackupScope["kind"] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(HISTORY_BACKUP_SCOPE_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const scopeKind = parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).scopeKind
      : null;
    if (
      parsed && typeof parsed === "object"
      && Object.keys(parsed).length === 2
      && (parsed as Record<string, unknown>).version === 1
      && ["selected", "filtered", "all"].includes(String(scopeKind || ""))
    ) {
      return scopeKind as HistoryBackupScope["kind"];
    }
  } catch {
    // Invalid state is removed below.
  }
  try { storage.removeItem(HISTORY_BACKUP_SCOPE_STORAGE_KEY); } catch { /* ignored */ }
  return null;
}

function storeScopeKind(storage: StorageLike | null, scopeKind: HistoryBackupScope["kind"]): void {
  if (!storage) return;
  try {
    storage.setItem(
      HISTORY_BACKUP_SCOPE_STORAGE_KEY,
      JSON.stringify({ version: 1, scopeKind }),
    );
  } catch {
    // The in-memory controller remains usable when storage is unavailable.
  }
}

function clearJobId(storage: StorageLike | null): void {
  try { storage?.removeItem(HISTORY_BACKUP_STORAGE_KEY); } catch { /* ignored */ }
  try { storage?.removeItem(HISTORY_BACKUP_SCOPE_STORAGE_KEY); } catch { /* ignored */ }
}

export function createHistoryBackupController(options: HistoryBackupControllerOptions = {}) {
  const fetchFn = options.fetch ?? currentFetch();
  const storage = options.storage === undefined ? currentStorage() : options.storage;
  const setTimeoutFn = options.setTimeout ?? defaultSetTimeout;
  const clearTimeoutFn = options.clearTimeout ?? defaultClearTimeout;
  const documentLike = options.document === undefined ? currentDocument() : options.document;
  let jobId: string | null = null;
  let timer: TimerHandle | null = null;
  let activeAbort: AbortController | null = null;
  let pollDelay = 750;
  let disposed = false;
  let generation = 0;
  let scopeKind: HistoryBackupScope["kind"] | null = null;
  const adoptedJobIds = new Set<string>();
  const deletions = new Map<string, Promise<HistoryBackupJob>>();

  const clearTimer = () => {
    if (timer !== null) clearTimeoutFn(timer);
    timer = null;
  };
  const abortActive = () => {
    activeAbort?.abort();
    activeAbort = null;
  };
  const isCurrent = (operationGeneration: number) => (
    operationGeneration === generation && !disposed
  );
  const beginIntent = (nextDisposed = false) => {
    generation += 1;
    disposed = nextDisposed;
    clearTimer();
    abortActive();
    return generation;
  };
  const supersededError = () => new DOMException("superseded", "AbortError");
  const deleteExact = (targetJobId: string): Promise<HistoryBackupJob> => {
    const existing = deletions.get(targetJobId);
    if (existing) return existing;
    const request = cancelHistoryBackup(targetJobId, { fetch: fetchFn });
    deletions.set(targetJobId, request);
    void request.then(
      () => { if (deletions.get(targetJobId) === request) deletions.delete(targetJobId); },
      () => { if (deletions.get(targetJobId) === request) deletions.delete(targetJobId); },
    );
    return request;
  };
  const retireExact = async (targetJobId: string): Promise<void> => {
    try {
      await deleteExact(targetJobId);
    } catch {
      // A replacement may proceed; server startup recovery owns failed cleanup.
    }
  };
  const waitForRetirements = (): Promise<void> | null => {
    const pending = [...deletions.values()];
    if (!pending.length) return null;
    return Promise.all(pending.map(async (request) => {
      try { await request; } catch { /* replacement may proceed */ }
    })).then(() => undefined);
  };
  const stop = (operationGeneration: number) => {
    if (!isCurrent(operationGeneration)) return;
    clearTimer();
  };
  const forget = (operationGeneration: number) => {
    if (!isCurrent(operationGeneration)) return;
    stop(operationGeneration);
    clearJobId(storage);
    jobId = null;
    scopeKind = null;
  };
  const observe = (operationGeneration: number, job: HistoryBackupJob): HistoryBackupJob => {
    const scopedJob = scopeKind ? { ...job, scope_kind: scopeKind } : job;
    if (!isCurrent(operationGeneration)) return scopedJob;
    options.onStatus?.(scopedJob);
    if (TERMINAL_STATUSES.has(job.status)) stop(operationGeneration);
    if (FORGET_STATUSES.has(job.status)) forget(operationGeneration);
    return scopedJob;
  };
  const schedule = (operationGeneration: number) => {
    if (!isCurrent(operationGeneration) || !jobId || timer !== null) return;
    const delay = pollDelay;
    timer = setTimeoutFn(async () => {
      if (!isCurrent(operationGeneration)) return;
      timer = null;
      await poll(operationGeneration);
    }, delay);
    if (isCurrent(operationGeneration)) {
      pollDelay = Math.min(2000, Math.round(pollDelay * 1.5));
    }
  };
  const poll = async (operationGeneration: number): Promise<HistoryBackupJob | null> => {
    if (!isCurrent(operationGeneration) || !jobId) return null;
    const currentJobId = jobId;
    const abort = new AbortController();
    activeAbort = abort;
    try {
      const job = await getHistoryBackup(currentJobId, { fetch: fetchFn, signal: abort.signal });
      if (!isCurrent(operationGeneration)) return null;
      const scopedJob = observe(operationGeneration, job);
      if (isCurrent(operationGeneration) && !TERMINAL_STATUSES.has(job.status)) {
        schedule(operationGeneration);
      }
      return scopedJob;
    } catch (error) {
      if (
        !isCurrent(operationGeneration)
        || abort.signal.aborted
        || (error instanceof DOMException && error.name === "AbortError")
      ) return null;
      const stableError = error instanceof HistoryBackupApiError
        ? error
        : new HistoryBackupApiError("backup_network_error", "backup_network_error", 0);
      options.onError?.(stableError);
      if (!isCurrent(operationGeneration)) return null;
      if (
        stableError.status === 0
        || stableError.status === 408
        || stableError.status === 429
        || stableError.status >= 500
      ) {
        schedule(operationGeneration);
      } else {
        forget(operationGeneration);
      }
      return null;
    } finally {
      if (activeAbort === abort) activeAbort = null;
    }
  };
  const cleanupOrphan = async (orphanJobId: string): Promise<void> => {
    if (adoptedJobIds.has(orphanJobId)) return;
    await retireExact(orphanJobId);
  };
  const acknowledge = (targetJobId?: string): boolean => {
    const current = jobId ?? readStoredHistoryBackupJobId(storage);
    if (!current || (targetJobId !== undefined && targetJobId !== current)) return false;
    generation += 1;
    clearTimer();
    abortActive();
    clearJobId(storage);
    jobId = null;
    scopeKind = null;
    return true;
  };

  return {
    async start(scope: HistoryBackupScope): Promise<HistoryBackupJob> {
      const previousJobId = jobId ?? readStoredHistoryBackupJobId(storage);
      const operationGeneration = beginIntent(false);
      jobId = null;
      scopeKind = null;
      clearJobId(storage);
      pollDelay = 750;
      if (previousJobId) await retireExact(previousJobId);
      const pendingRetirements = waitForRetirements();
      if (pendingRetirements) await pendingRetirements;
      if (!isCurrent(operationGeneration)) throw supersededError();
      const abort = new AbortController();
      activeAbort = abort;
      try {
        const job = await createHistoryBackup(scope, { fetch: fetchFn, signal: abort.signal });
        if (!isCurrent(operationGeneration)) {
          await cleanupOrphan(job.job_id);
          throw supersededError();
        }
        jobId = job.job_id;
        scopeKind = scope.kind;
        adoptedJobIds.add(jobId);
        storeJobId(storage, jobId);
        storeScopeKind(storage, scopeKind);
        const scopedJob = observe(operationGeneration, job);
        if (isCurrent(operationGeneration) && !TERMINAL_STATUSES.has(job.status)) {
          schedule(operationGeneration);
        }
        return scopedJob;
      } finally {
        if (activeAbort === abort) activeAbort = null;
      }
    },
    async resume(): Promise<HistoryBackupJob | null> {
      const operationGeneration = beginIntent(false);
      jobId = readStoredHistoryBackupJobId(storage);
      scopeKind = jobId ? readStoredScopeKind(storage) : null;
      if (jobId) adoptedJobIds.add(jobId);
      pollDelay = 750;
      return jobId && isCurrent(operationGeneration)
        ? await poll(operationGeneration)
        : null;
    },
    async cancel(): Promise<HistoryBackupJob | null> {
      const current = jobId ?? readStoredHistoryBackupJobId(storage);
      const currentScopeKind = scopeKind ?? readStoredScopeKind(storage);
      const operationGeneration = beginIntent(false);
      jobId = null;
      scopeKind = null;
      clearJobId(storage);
      if (!current) return null;
      const job = await deleteExact(current);
      if (isCurrent(operationGeneration)) {
        if (!TERMINAL_STATUSES.has(job.status)) {
          jobId = current;
          scopeKind = currentScopeKind;
          adoptedJobIds.add(current);
          storeJobId(storage, current);
          if (scopeKind) storeScopeKind(storage, scopeKind);
        }
        const scopedJob = observe(operationGeneration, job);
        if (isCurrent(operationGeneration) && !TERMINAL_STATUSES.has(job.status)) {
          pollDelay = 750;
          schedule(operationGeneration);
        }
        return scopedJob;
      }
      return job;
    },
    async dismiss(targetJobId?: string): Promise<boolean> {
      const current = jobId ?? readStoredHistoryBackupJobId(storage);
      if (!current || (targetJobId !== undefined && targetJobId !== current)) return false;
      const operationGeneration = beginIntent(false);
      try {
        await deleteExact(current);
      } catch (error) {
        if (!(error instanceof HistoryBackupApiError && error.status === 404)) throw error;
      }
      if (!isCurrent(operationGeneration)) return false;
      clearJobId(storage);
      jobId = null;
      scopeKind = null;
      return true;
    },
    acknowledge,
    download(job: HistoryBackupJob): void {
      if (job.status !== "ready") {
        throw new HistoryBackupApiError("backup_download_not_ready", "backup_download_not_ready", 409);
      }
      if (typeof job.download_url !== "string" || !job.download_url) {
        throw new HistoryBackupApiError("backup_download_unavailable", "backup_download_unavailable", 422);
      }
      const current = jobId ?? readStoredHistoryBackupJobId(storage);
      if (!current || job.job_id !== current) {
        throw new HistoryBackupApiError("backup_download_job_mismatch", "backup_download_job_mismatch", 409);
      }
      directDownloadHistoryBackup(job.download_url, documentLike);
      if (!acknowledge(job.job_id)) {
        throw new HistoryBackupApiError("backup_download_job_mismatch", "backup_download_job_mismatch", 409);
      }
    },
    dispose(): void {
      beginIntent(true);
    },
    activeJobId(): string | null { return jobId; },
  };
}
