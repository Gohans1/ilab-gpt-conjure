import type {
  HistoryScrollAnchor,
  HistoryWindowDirection,
} from "./history-window";

export const HISTORY_LOCATION_KEY =
  "ilab-conjure-history-location-v1";
export const HISTORY_LOCATION_MAX_QUERY_LENGTH = 8192;
export const HISTORY_LOCATION_MAX_OFFSET = 1_000_000;

export const HISTORY_FILTER_QUERY_KEYS = [
  "mode",
  "month",
  "prompt_mode",
  "quality",
  "ratio",
  "orientation",
  "backend",
  "provider",
  "archived",
] as const;

export const HISTORY_ORGANIZER_QUERY_KEYS = [
  "favorite",
  "tag",
  "untagged",
] as const;

export const HISTORY_EXPLICIT_NAVIGATION_KEYS = [
  "task",
  "q",
  "sort",
  "view",
  ...HISTORY_FILTER_QUERY_KEYS,
  ...HISTORY_ORGANIZER_QUERY_KEYS,
] as const;

const HISTORY_SNAPSHOT_QUERY_KEYS = [
  "q",
  "sort",
  "view",
  ...HISTORY_FILTER_QUERY_KEYS,
  ...HISTORY_ORGANIZER_QUERY_KEYS,
] as const;

type HistoryLocationAnchor = NonNullable<HistoryScrollAnchor>;

export type HistoryLocationSnapshot = {
  version: 1;
  query: string;
  anchor: HistoryLocationAnchor;
  savedAt: number;
};

export type HistoryLoadOptions = {
  reset?: boolean;
  direction?: HistoryWindowDirection;
  anchorTaskId?: string;
  anchor?: HistoryScrollAnchor;
};

export type HistoryLoadResult = {
  anchorFound: boolean | null;
  taskCount: number;
};

type HistoryLocationStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

function defaultHistoryLocationStorage(): HistoryLocationStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function historyLocationStorage(
  storage?: HistoryLocationStorage | null,
): HistoryLocationStorage | null {
  return storage ?? defaultHistoryLocationStorage();
}

function normalizedHistoryLocationSnapshot(
  value: unknown,
): HistoryLocationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return null;
  if (
    typeof candidate.query !== "string" ||
    candidate.query.length > HISTORY_LOCATION_MAX_QUERY_LENGTH
  ) {
    return null;
  }
  if (
    typeof candidate.savedAt !== "number" ||
    !Number.isFinite(candidate.savedAt)
  ) {
    return null;
  }
  if (
    !candidate.anchor ||
    typeof candidate.anchor !== "object" ||
    Array.isArray(candidate.anchor)
  ) {
    return null;
  }
  const anchor = candidate.anchor as Record<string, unknown>;
  if (typeof anchor.taskId !== "string") return null;
  const taskId = anchor.taskId.trim();
  if (!taskId) return null;
  if (
    typeof anchor.offset !== "number" ||
    !Number.isFinite(anchor.offset)
  ) {
    return null;
  }
  return {
    version: 1,
    query: candidate.query,
    anchor: {
      taskId,
      offset: Math.max(
        -HISTORY_LOCATION_MAX_OFFSET,
        Math.min(HISTORY_LOCATION_MAX_OFFSET, anchor.offset),
      ),
    },
    savedAt: candidate.savedAt,
  };
}

function removeHistoryLocationSnapshot(
  storage: HistoryLocationStorage,
): boolean {
  try {
    storage.removeItem(HISTORY_LOCATION_KEY);
    return true;
  } catch {
    return false;
  }
}

export function readHistoryLocationSnapshot(
  storage?: HistoryLocationStorage | null,
): HistoryLocationSnapshot | null {
  const target = historyLocationStorage(storage);
  if (!target) return null;
  let raw: string | null;
  try {
    raw = target.getItem(HISTORY_LOCATION_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removeHistoryLocationSnapshot(target);
    return null;
  }
  const snapshot = normalizedHistoryLocationSnapshot(parsed);
  if (!snapshot) removeHistoryLocationSnapshot(target);
  return snapshot;
}

export function saveHistoryLocationSnapshot(
  snapshot: HistoryLocationSnapshot,
  storage?: HistoryLocationStorage | null,
): boolean {
  const normalized = normalizedHistoryLocationSnapshot(snapshot);
  if (!normalized) return false;
  const target = historyLocationStorage(storage);
  if (!target) return false;
  try {
    target.setItem(HISTORY_LOCATION_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function clearHistoryLocationSnapshot(
  storage?: HistoryLocationStorage | null,
): boolean {
  const target = historyLocationStorage(storage);
  return target ? removeHistoryLocationSnapshot(target) : false;
}

export function historyUrlHasExplicitNavigation(
  params: URLSearchParams,
): boolean {
  return HISTORY_EXPLICIT_NAVIGATION_KEYS.some((key) => params.has(key));
}

export function historySnapshotQuery(params: URLSearchParams): string {
  const snapshot = new URLSearchParams();
  for (const key of HISTORY_SNAPSHOT_QUERY_KEYS) {
    if (!params.has(key)) continue;
    if (key === "sort") {
      if (params.get(key) === "oldest") snapshot.set(key, "oldest");
      continue;
    }
    if (key === "view") {
      if (params.get(key) === "list") snapshot.set(key, "list");
      continue;
    }
    if (key === "tag") {
      for (const value of params.getAll(key)) snapshot.append(key, value);
      continue;
    }
    snapshot.append(key, params.get(key) ?? "");
  }
  return snapshot.toString();
}
