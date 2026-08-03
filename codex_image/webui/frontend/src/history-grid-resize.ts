type HistoryGridResizeControllerOptions = {
  isResizing: () => boolean;
  scheduleLayout: () => void;
  epsilon?: number;
};

export type HistoryGridResizeController = {
  commitLayout: (width: number) => void;
  observeWidth: (width: number) => void;
};

export type HistoryGridCardLayoutState = {
  width: string;
  rowHeight: string;
};

export type HistoryGridWidthMeasurement = {
  boundingWidth: number;
  clientWidth: number;
  offsetWidth: number;
  paddingLeft: number;
  paddingRight: number;
};

function usableWidth(width: number): boolean {
  return Number.isFinite(width) && width > 0;
}

function positiveCssPixels(value: string): boolean {
  const pixels = Number.parseFloat(value);
  return Number.isFinite(pixels) && pixels > 0;
}

export function historyGridAvailableWidth({
  boundingWidth,
  clientWidth,
  offsetWidth,
  paddingLeft,
  paddingRight,
}: HistoryGridWidthMeasurement): number {
  const borderAndScrollbarWidth = Math.max(0, offsetWidth - clientWidth);
  const physicalWidth = usableWidth(boundingWidth) ? boundingWidth : offsetWidth;
  return Math.max(0, Math.floor(
    physicalWidth - borderAndScrollbarWidth - paddingLeft - paddingRight,
  ));
}

export function historyGridCardsNeedLayout(
  cards: readonly HistoryGridCardLayoutState[],
): boolean {
  return cards.some(({ width, rowHeight }) => (
    !positiveCssPixels(width) || !positiveCssPixels(rowHeight)
  ));
}

export function createHistoryGridResizeController({
  isResizing,
  scheduleLayout,
  epsilon = 0.5,
}: HistoryGridResizeControllerOptions): HistoryGridResizeController {
  let committedWidth = Number.NaN;
  let observedWidth = Number.NaN;

  return {
    commitLayout(width) {
      if (!usableWidth(width)) return;
      committedWidth = Math.floor(width);
      observedWidth = committedWidth;
    },
    observeWidth(width) {
      if (!usableWidth(width)) return;
      const normalizedWidth = Math.floor(width);
      if (Number.isFinite(observedWidth) && Math.abs(normalizedWidth - observedWidth) <= epsilon) return;
      observedWidth = normalizedWidth;
      if (isResizing()) return;
      if (Number.isFinite(committedWidth) && Math.abs(normalizedWidth - committedWidth) <= epsilon) return;
      scheduleLayout();
    },
  };
}
