export interface StagedReference {
  url: string;
  name: string;
  sourceTaskId: string;
  outputIndex: number | null;
}

type StagedReferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const STAGED_REFERENCES_SESSION_KEY = "codex-image-staged-references";

function currentSessionStorage(): StagedReferenceStorage | null {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
}

function normalizeStagedReferences(value: unknown): StagedReference[] {
  if (!Array.isArray(value)) return [];
  const references: StagedReference[] = [];
  const seenUrls = new Set<string>();
  value.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url.trim() : "";
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    references.push({
      url,
      name: typeof record.name === "string" ? record.name : "",
      sourceTaskId: typeof record.sourceTaskId === "string" ? record.sourceTaskId : "",
      outputIndex: Number.isInteger(record.outputIndex) && Number(record.outputIndex) > 0
        ? Number(record.outputIndex)
        : null,
    });
  });
  return references;
}

export function persistStagedReferences(
  value: unknown,
  storage: StagedReferenceStorage | null = currentSessionStorage(),
): void {
  if (!storage) return;
  try {
    const references = normalizeStagedReferences(value);
    if (!references.length) {
      storage.removeItem(STAGED_REFERENCES_SESSION_KEY);
      return;
    }
    storage.setItem(STAGED_REFERENCES_SESSION_KEY, JSON.stringify(references));
  } catch {
    // Staging remains available in memory when browser storage is unavailable.
  }
}

export function readStagedReferences(
  storage: StagedReferenceStorage | null = currentSessionStorage(),
): StagedReference[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(STAGED_REFERENCES_SESSION_KEY);
    if (!raw) return [];
    return normalizeStagedReferences(JSON.parse(raw));
  } catch {
    try {
      storage.removeItem(STAGED_REFERENCES_SESSION_KEY);
    } catch {
      // Ignore cleanup failures in restricted browser contexts.
    }
    return [];
  }
}
