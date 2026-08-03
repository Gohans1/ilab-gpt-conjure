import {
  HISTORY_FILTER_QUERY_KEYS,
} from "./history-scroll-memory";

export type HistoryActiveFilterKey =
  (typeof HISTORY_FILTER_QUERY_KEYS)[number];

export type HistoryActiveFilterSnapshot = {
  q: string;
  filters: Partial<Record<HistoryActiveFilterKey, string>>;
  organization: {
    favorite: boolean;
    tagIds: string[];
    untagged: boolean;
  };
};

export type HistoryActiveFilterItem =
  | { id: "q"; kind: "q"; value: string }
  | {
      id: `filter:${HistoryActiveFilterKey}`;
      kind: "filter";
      key: HistoryActiveFilterKey;
      value: string;
    }
  | { id: "favorite"; kind: "favorite"; value: "true" }
  | { id: "untagged"; kind: "untagged"; value: "true" }
  | { id: `tag:${string}`; kind: "tag"; value: string };

function uniqueNonempty(values: Iterable<unknown>): string[] {
  return [
    ...new Set(
      [...values]
        .map((value) => String(value ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function copySnapshot(
  snapshot: HistoryActiveFilterSnapshot,
): HistoryActiveFilterSnapshot {
  return {
    q: snapshot.q,
    filters: { ...snapshot.filters },
    organization: {
      favorite: snapshot.organization.favorite,
      tagIds: [...snapshot.organization.tagIds],
      untagged: snapshot.organization.untagged,
    },
  };
}

export function collectHistoryActiveFilters(
  snapshot: HistoryActiveFilterSnapshot,
): HistoryActiveFilterItem[] {
  const items: HistoryActiveFilterItem[] = [];
  const query = String(snapshot.q || "").trim();
  if (query) items.push({ id: "q", kind: "q", value: query });
  for (const key of HISTORY_FILTER_QUERY_KEYS) {
    const value = String(snapshot.filters[key] || "").trim();
    if (!value) continue;
    items.push({
      id: `filter:${key}`,
      kind: "filter",
      key,
      value,
    });
  }
  if (snapshot.organization.favorite) {
    items.push({
      id: "favorite",
      kind: "favorite",
      value: "true",
    });
  }
  if (snapshot.organization.untagged) {
    items.push({
      id: "untagged",
      kind: "untagged",
      value: "true",
    });
    return items;
  }
  for (const tagId of uniqueNonempty(
    snapshot.organization.tagIds,
  )) {
    items.push({
      id: `tag:${tagId}`,
      kind: "tag",
      value: tagId,
    });
  }
  return items;
}

export function removeHistoryActiveFilter(
  snapshot: HistoryActiveFilterSnapshot,
  item: HistoryActiveFilterItem,
): HistoryActiveFilterSnapshot {
  const next = copySnapshot(snapshot);
  if (item.kind === "q") {
    next.q = "";
  } else if (item.kind === "filter") {
    next.filters[item.key] = "";
  } else if (item.kind === "favorite") {
    next.organization.favorite = false;
  } else if (item.kind === "untagged") {
    next.organization.untagged = false;
  } else if (item.kind === "tag") {
    next.organization.tagIds = next.organization.tagIds.filter(
      (tagId) => tagId !== item.value,
    );
  }
  return next;
}

export function clearHistoryActiveFilters(
  snapshot: HistoryActiveFilterSnapshot,
): HistoryActiveFilterSnapshot {
  return {
    q: "",
    filters: Object.fromEntries(
      HISTORY_FILTER_QUERY_KEYS.map((key) => [key, ""]),
    ) as Record<HistoryActiveFilterKey, string>,
    organization: {
      favorite: false,
      tagIds: [],
      untagged: false,
    },
  };
}
