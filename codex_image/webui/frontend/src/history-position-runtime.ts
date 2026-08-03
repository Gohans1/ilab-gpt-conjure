// Node's native TypeScript test runner requires an explicit extension.
// @ts-expect-error TS5097 -- production bundling resolves the same source file.
import { HISTORY_FILTER_QUERY_KEYS, historyUrlHasExplicitNavigation, type HistoryLoadOptions, type HistoryLoadResult, type HistoryLocationSnapshot } from "./history-scroll-memory.ts";
import type {
  HistoryScrollAnchor,
  HistoryWindowDirection,
} from "./history-window";

type HistoryFilterKey = (typeof HISTORY_FILTER_QUERY_KEYS)[number];

export type HistoryPageQueryInput = {
  limit: number;
  sort: string;
  cursor?: string | null | undefined;
  direction?: HistoryWindowDirection;
  anchorTaskId?: string;
  q?: string;
  filters?: Partial<Record<HistoryFilterKey, string>>;
  organization?: {
    favorite: boolean;
    tagIds: readonly string[];
    untagged: boolean;
  };
};

export type HistoryAnchorPage<Task> = {
  tasks: Task[];
  next_cursor: string | null;
  previous_cursor?: string | null;
  anchor_found?: boolean;
};

type HistoryPositionBootOptions = {
  params: URLSearchParams;
  pathname: string;
  snapshot: HistoryLocationSnapshot | null;
  replaceLocation: (url: string) => void;
  syncLocation: () => void;
  loadPage: (options: HistoryLoadOptions) => Promise<HistoryLoadResult>;
  clearSnapshot: () => unknown;
};

type HistoryAnchorPageOptions<Task> = {
  query: HistoryPageQueryInput;
  anchor: HistoryScrollAnchor;
  request: (url: string) => Promise<HistoryAnchorPage<Task>>;
  isCurrent: () => boolean;
  validate?: (tasks: Task[]) => void;
  render: (tasks: Task[]) => void;
  applyCursors: (previous: string | null, next: string | null) => void;
  requestFrame: (callback: () => void) => number;
  restore: (anchor: HistoryScrollAnchor) => void;
  enableSave: () => void;
};

const EMPTY_HISTORY_LOAD_RESULT: HistoryLoadResult = {
  anchorFound: null,
  taskCount: 0,
};

export function historyTaskPageQuery(input: HistoryPageQueryInput): string {
  const params = new URLSearchParams();
  params.set("limit", String(input.limit));
  params.set("sort", input.sort);
  if (input.anchorTaskId) {
    params.set("anchor_task_id", input.anchorTaskId);
  } else {
    if (input.cursor) params.set("cursor", input.cursor);
    if (input.direction && input.direction !== "next") {
      params.set("direction", input.direction);
    }
  }
  if (input.q) params.set("q", input.q);
  for (const key of HISTORY_FILTER_QUERY_KEYS) {
    const value = input.filters?.[key];
    if (value) params.set(key, value);
  }
  if (input.organization?.favorite) params.set("favorite", "true");
  if (input.organization?.untagged) {
    params.set("untagged", "true");
  } else {
    const tagIds = new Set(
      (input.organization?.tagIds ?? [])
        .map((value) => String(value).trim())
        .filter(Boolean),
    );
    for (const tagId of tagIds) params.append("tag", tagId);
  }
  return params.toString();
}

export async function runHistoryPositionBoot(
  options: HistoryPositionBootOptions,
): Promise<HistoryLoadResult> {
  const pending = historyUrlHasExplicitNavigation(options.params)
    ? null
    : options.snapshot;
  if (pending) {
    options.replaceLocation(
      pending.query
        ? `${options.pathname}?${pending.query}`
        : options.pathname,
    );
  }
  options.syncLocation();
  if (!pending) return options.loadPage({ reset: true });
  const result = await options.loadPage({
    reset: true,
    anchorTaskId: pending.anchor.taskId,
    anchor: pending.anchor,
  });
  if (result.anchorFound !== false) return result;
  options.clearSnapshot();
  return options.loadPage({ reset: true });
}

export async function loadHistoryAnchorPage<Task>(
  options: HistoryAnchorPageOptions<Task>,
): Promise<HistoryLoadResult> {
  const page = await options.request(
    `/api/task-history/tasks?${historyTaskPageQuery(options.query)}`,
  );
  if (!options.isCurrent()) return EMPTY_HISTORY_LOAD_RESULT;
  const tasks = page.tasks ?? [];
  options.validate?.(tasks);
  if (!options.isCurrent()) return EMPTY_HISTORY_LOAD_RESULT;
  const anchorFound = page.anchor_found === true
    ? true
    : page.anchor_found === false
      ? false
      : null;
  if (!options.isCurrent()) return EMPTY_HISTORY_LOAD_RESULT;
  if (anchorFound !== true) {
    return { anchorFound, taskCount: tasks.length };
  }
  return new Promise((resolve, reject) => {
    try {
      options.requestFrame(() => {
        try {
          if (!options.isCurrent()) {
            resolve(EMPTY_HISTORY_LOAD_RESULT);
            return;
          }
          options.render(tasks);
          options.applyCursors(
            page.previous_cursor ?? null,
            page.next_cursor ?? null,
          );
          options.restore(options.anchor);
          options.enableSave();
          resolve({ anchorFound: true, taskCount: tasks.length });
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}
