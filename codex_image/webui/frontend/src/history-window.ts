export type HistoryWindowDirection = "next" | "previous";
export type HistoryWindowEdge = "top" | "bottom";
export type HistoryTaskArrowKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

export const HISTORY_TASK_ARROW_KEYS = new Set<HistoryTaskArrowKey>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export type HistoryScrollAnchor = {
  taskId: string;
  offset: number;
} | null;

type HistoryPositionSaveControllerOptions = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frameId: number) => void;
  capture: () => HistoryScrollAnchor;
  save: (anchor: NonNullable<HistoryScrollAnchor>) => void;
};

export type HistoryPositionSaveController = {
  enable: () => void;
  schedule: () => void;
  flush: () => void;
};

export function createHistoryPositionSaveController(
  options: HistoryPositionSaveControllerOptions,
): HistoryPositionSaveController {
  let enabled = false;
  let frameId: number | null = null;
  const captureAndSave = () => {
    const anchor = options.capture();
    if (anchor) options.save(anchor);
  };
  return {
    enable() {
      enabled = true;
    },
    schedule() {
      if (!enabled || frameId !== null) return;
      frameId = options.requestFrame(() => {
        frameId = null;
        captureAndSave();
      });
    },
    flush() {
      if (!enabled) return;
      if (frameId !== null) {
        options.cancelFrame(frameId);
        frameId = null;
      }
      captureAndSave();
    },
  };
}

type HistoryTaskCardCenter = {
  card: HTMLElement;
  x: number;
  y: number;
};

export function historyTaskCards(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".history-task-card[data-history-task-card-id]")];
}

export function isHistoryTaskArrowKey(key: string): key is HistoryTaskArrowKey {
  return HISTORY_TASK_ARROW_KEYS.has(key as HistoryTaskArrowKey);
}

function historyTaskCardCenter(card: HTMLElement): HistoryTaskCardCenter {
  const rect = card.getBoundingClientRect();
  return {
    card,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function historyGridVerticalArrowTargetCard(cards: HTMLElement[], currentCard: HTMLElement, key: "ArrowUp" | "ArrowDown"): HTMLElement | null {
  const current = historyTaskCardCenter(currentCard);
  let bestCard: HTMLElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  cards.forEach((card) => {
    if (card === currentCard) return;
    const candidate = historyTaskCardCenter(card);
    const dx = Math.abs(candidate.x - current.x);
    const dy = candidate.y - current.y;
    if (key === "ArrowUp" && dy >= -1) return;
    if (key === "ArrowDown" && dy <= 1) return;
    const primaryDistance = Math.abs(dy);
    const score = primaryDistance * 10000 + dx;
    if (score >= bestScore) return;
    bestScore = score;
    bestCard = candidate.card;
  });
  return bestCard;
}

export function historyTaskArrowTargetCard(
  root: HTMLElement,
  currentTaskId: string,
  key: HistoryTaskArrowKey,
  view: "grid" | "list",
): HTMLElement | null {
  const cards = historyTaskCards(root);
  const currentIndex = cards.findIndex((card) => String(card.dataset.historyTaskCardId || "") === currentTaskId);
  if (currentIndex < 0) return null;
  const currentCard = cards[currentIndex];
  if (!currentCard) return null;
  if (view === "list") {
    if (key !== "ArrowUp" && key !== "ArrowDown") return null;
    return cards[currentIndex + (key === "ArrowDown" ? 1 : -1)] ?? null;
  }
  if (key === "ArrowLeft") return cards[currentIndex - 1] ?? null;
  if (key === "ArrowRight") return cards[currentIndex + 1] ?? null;
  return historyGridVerticalArrowTargetCard(cards, currentCard, key);
}

export function encodeHistoryCursor(createdAt: string, taskId: string): string {
  const raw = JSON.stringify({ created_at: createdAt, task_id: taskId });
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function historyWindowEdgeCursor(root: HTMLElement, edge: HistoryWindowEdge): string {
  const cards = historyTaskCards(root);
  const card = edge === "top" ? cards[0] : cards[cards.length - 1];
  if (!card) return "";
  const taskId = String(card.dataset.historyTaskCardId || "");
  const createdAt = String(card.dataset.historyCreatedAt || "");
  return taskId && createdAt ? encodeHistoryCursor(createdAt, taskId) : "";
}

export function captureHistoryScrollAnchor(root: HTMLElement): HistoryScrollAnchor {
  const rootTop = root.getBoundingClientRect().top;
  for (const card of historyTaskCards(root)) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom < rootTop) continue;
    const taskId = String(card.dataset.historyTaskCardId || "");
    if (!taskId) continue;
    return { taskId, offset: rect.top - rootTop };
  }
  return null;
}

export function restoreHistoryScrollAnchor(root: HTMLElement, anchor: HistoryScrollAnchor): void {
  if (!anchor) return;
  const card = historyTaskCards(root).find((item) => String(item.dataset.historyTaskCardId || "") === anchor.taskId);
  if (!card) return;
  const rootTop = root.getBoundingClientRect().top;
  const nextOffset = card.getBoundingClientRect().top - rootTop;
  root.scrollTop += nextOffset - anchor.offset;
}
