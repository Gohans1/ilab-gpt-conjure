import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { CHATGPT_URL, SELECTORS, detectImageExtension } from "./config.js";
import { getBrowserSession, type BrowserOptions, type BrowserSession } from "./browser.js";
import { extractAndSaveImages, type DownloadResult } from "./downloader.js";
import {
  allowedAuthUrl,
  checkIsLoggedIn,
  dismissChatGptModalsAndOnboarding,
  dismissCookieBannerIfPresent,
  saveSanitizedStorageState,
  throwIfChatGptRateLimitDialog,
  throwIfChatGptSessionFailureAlert,
} from "./auth-helper.js";
import { clearSessionVerified, isSessionCached } from "./check-session.js";

export const UUID_CONV_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const INVALID_CONVERSATION_SLUGS = new Set([
  "web",
  "init",
  "prepare",
  "share",
  "models",
  "anonymous",
  "conversation",
  "conversations",
  "backend-api",
  "gen_title",
  "feedback",
  "interpreter",
  "metadata",
  "temporary",
]);

export function isValidConversationId(id: string | null | undefined): boolean {
  if (!id || typeof id !== "string") return false;
  if (/\s/.test(id)) return false;
  if (INVALID_CONVERSATION_SLUGS.has(id.toLowerCase())) return false;
  return UUID_CONV_REGEX.test(id);
}

export async function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    throw new Error("Quá trình sinh ảnh đã bị hủy bởi client (Client aborted request)");
  }
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error("Quá trình sinh ảnh đã bị hủy bởi client (Client aborted request)")),
        { once: true }
      );
    }),
  ]);
}

export function validateInputImage(filePath: string): void {
  if (!existsSync(filePath)) {
    throw new Error(`Không tìm thấy file ảnh tham chiếu: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`Đường dẫn ảnh tham chiếu không phải là file: ${filePath}`);
  }
  const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
  if (stat.size > MAX_IMAGE_SIZE) {
    throw new Error(`File ảnh tham chiếu vượt quá kích thước cho phép (tối đa 20MB): ${filePath}`);
  }
  if (stat.size < 12) {
    throw new Error(`File ảnh tham chiếu không hợp lệ hoặc quá nhỏ: ${filePath}`);
  }
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(16);
  try {
    readSync(fd, buf, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  const ext = detectImageExtension(buf);
  if (!ext) {
    throw new Error(`File ảnh tham chiếu không đúng định dạng hỗ trợ (PNG, JPG, WEBP, GIF): ${filePath}`);
  }
}

export interface GenerateOptions extends BrowserOptions {
  outputPath?: string;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxTimeoutMs?: number;
  skipDiskWrite?: boolean;
  deleteChatAfterGen?: boolean;
  inputImages?: string[];
  expectedCount?: number;
  signal?: AbortSignal;
}

export function resolveTimeoutOptions(options: GenerateOptions = {}): {
  idleTimeoutMs: number;
  maxTimeoutMs: number;
} {
  const envIdle = process.env.CHATGPT_BRIDGE_IDLE_TIMEOUT_MS;
  const envMax = process.env.CHATGPT_BRIDGE_MAX_TIMEOUT_MS;

  const idleTimeoutMs = options.idleTimeoutMs ?? (envIdle ? Number(envIdle) : 60_000);
  const maxTimeoutMs = options.maxTimeoutMs ?? options.timeoutMs ?? (envMax ? Number(envMax) : 600_000);

  return {
    idleTimeoutMs: Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0 ? idleTimeoutMs : 60_000,
    maxTimeoutMs: Number.isFinite(maxTimeoutMs) && maxTimeoutMs > 0 ? maxTimeoutMs : 600_000,
  };
}

export function resolveDeleteChatOption(deleteChatAfterGen?: boolean): boolean {
  return deleteChatAfterGen ?? (process.env.CHATGPT_DELETE_CHAT !== "false");
}

export function resolveInputImages(input?: unknown): string[] {
  if (!input) return [];
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(input)) {
    return input
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .map((item) => item.trim());
  }
  return [];
}

export function extractImageKey(src: string): string {
  if (!src) return "";
  const match = src.match(/[?&]id=([^&]+)/);
  return match ? match[1] : src;
}

export async function attachImagesToChatGPT(
  page: any,
  imagePaths: string[],
  options: { timeoutMs?: number; settleMs?: number } = {}
): Promise<void> {
  const paths = resolveInputImages(imagePaths);
  if (paths.length === 0) return;

  const timeout = options.timeoutMs ?? 15_000;
  const settleMs = options.settleMs ?? 1_500;

  let uploaded = false;

  // 1. Thử tìm thẻ input[type="file"] có sẵn trong DOM
  try {
    const fileInput = page.locator(SELECTORS.fileInput).first();
    const inputCount = await fileInput.count().catch(() => 0);

    if (inputCount > 0) {
      const isMultiple = typeof fileInput.getAttribute === "function"
        ? await fileInput.getAttribute("multiple").then((val: any) => val !== null).catch(() => false)
        : false;
      if (!isMultiple && paths.length > 1) {
        console.warn(`⚠️ Giao diện ChatGPT không hỗ trợ upload nhiều ảnh cùng lúc. Chỉ ảnh đầu tiên (${paths[0]}) được đính kèm.`);
      }
      const filesToUpload = isMultiple || paths.length === 1 ? paths : paths.slice(0, 1);
      await fileInput.setInputFiles(filesToUpload, { timeout });
      uploaded = true;
    }
  } catch {}

  // 2. Fallback nếu thẻ input chưa có trong DOM hoặc setInputFiles gặp lỗi
  if (!uploaded) {
    try {
      const attachBtn = page.locator(SELECTORS.attachButton).first();
      const fileChooserPromise = page.waitForEvent("filechooser", { timeout: 8_000 }).catch(() => null);
      const clickPromise = attachBtn.click({ timeout: 5000 }).catch(() => {});
      const [fileChooser] = await Promise.all([fileChooserPromise, clickPromise]);
      if (fileChooser) {
        const canMultiple = typeof fileChooser.isMultiple === "function" ? fileChooser.isMultiple() : true;
        const filesToSet = canMultiple || paths.length === 1 ? paths : paths.slice(0, 1);
        await fileChooser.setFiles(filesToSet);
        uploaded = true;
      }
    } catch {}
  }

  if (!uploaded) {
    throw new Error("Không thể nạp ảnh tham chiếu vào giao diện ChatGPT (không tìm thấy input file hoặc nút đính kèm).");
  }

  // 3. Đợi thumbnail xuất hiện
  const thumbnail = page.locator(`form ${SELECTORS.attachmentThumbnail}, ${SELECTORS.attachmentThumbnail}`).first();
  const hasThumb = await thumbnail.waitFor({ state: "attached", timeout: 20_000 }).then(() => true).catch(() => false);
  if (!hasThumb) {
    throw new Error("Giao diện ChatGPT không hiển thị thumbnail ảnh đính kèm sau khi nạp file.");
  }

  // 4. Chờ indicator uploading biến mất (nếu đang tải ảnh lên)
  const uploading = page.locator(SELECTORS.attachmentUploading).first();
  await uploading.waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});

  await page.waitForTimeout(settleMs);
}


export function sizeToAspectRatio(sizeOrRatio?: string | null): string | null {
  if (!sizeOrRatio || typeof sizeOrRatio !== "string") return null;
  const s = sizeOrRatio.trim().toLowerCase();

  // Bỏ qua nếu là None / off / null / auto
  if (s === "none" || s === "off" || s === "null" || s === "undefined" || s === "auto") {
    return null;
  }

  // Đã là dạng tỷ lệ X:Y nguyên dương (ví dụ "16:9", "1:1", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9")
  if (/^[1-9][0-9]*:[1-9][0-9]*$/.test(s)) {
    return s;
  }

  // Dạng kích thước pixel WxH (ví dụ "1792x1024", "1024x1024", "1024x1792")
  const match = s.match(/^([0-9]+)\s*[xX×]\s*([0-9]+)$/);
  if (match) {
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w <= 0 || h <= 0) return null;

    const ratio = w / h;
    const standardRatios: Array<[string, number]> = [
      ["1:1", 1],
      ["16:9", 16 / 9],
      ["9:16", 9 / 16],
      ["4:3", 4 / 3],
      ["3:4", 3 / 4],
      ["3:2", 3 / 2],
      ["2:3", 2 / 3],
      ["21:9", 21 / 9],
    ];

    let bestMatch: string | null = null;
    let minDiff = 0.04;
    for (const [name, targetRatio] of standardRatios) {
      const diff = Math.abs(ratio - targetRatio);
      if (diff < minDiff) {
        minDiff = diff;
        bestMatch = name;
      }
    }
    if (bestMatch) return bestMatch;

    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const d = gcd(w, h);
    return `${w / d}:${h / d}`;
  }

  return null;
}

export function insertPlainTextIntoComposer(element: HTMLElement, value: string): boolean {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced =
    selection.isCollapsed &&
    selection.anchorNode !== null &&
    element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (!selection.isCollapsed || !selection.anchorNode || !element.contains(selection.anchorNode)) {
    return false;
  }
  return document.execCommand("insertText", false, value);
}

export async function captureDiagnosticSnapshot(page: Page, prefix: string = "error"): Promise<void> {
  try {
    if (!page || page.isClosed()) return;
    const diagDir = join(process.cwd(), "output", "diagnostics");
    mkdirSync(diagDir, { recursive: true });
    const timestamp = Date.now();
    const stem = `${prefix}_${timestamp}`;
    const screenshotPath = join(diagDir, `${stem}.png`);
    const dumpPath = join(diagDir, `${stem}.json`);

    let savedScreenshot = false;
    await page
      .screenshot({ path: screenshotPath, timeout: 5_000, animations: "disabled" })
      .then(() => {
        savedScreenshot = true;
      })
      .catch(() => {});

    const domState = await page.evaluate((sel) => {
      const stopBtn = document.querySelector(sel.stopButton);
      const copyBtn = document.querySelector(sel.completionAction);
      const lastTurn = document.querySelector('article:last-of-type, [data-testid^="conversation-turn-"]:last-of-type');
      const dialog = document.querySelector('[role="dialog"]:not([aria-hidden="true"]):not([data-state="closed"]), [role="alertdialog"]:not([aria-hidden="true"]):not([data-state="closed"])');
      const imagesFoundCount = document.querySelectorAll(sel.generatedImage || 'img').length;
      return {
        timestamp: new Date().toISOString(),
        url: window.location.href,
        title: document.title,
        metrics: {
          hasStopButton: Boolean(stopBtn),
          hasCompletionAction: Boolean(copyBtn),
          hasActiveDialog: Boolean(dialog),
          imagesFoundCount,
          lastTurnTextSnippet: (lastTurn?.textContent || "").trim().slice(0, 500),
        },
        bodyTextSnippet: document.body ? (document.body.textContent || "").trim().slice(0, 1500) : "",
      };
    }, SELECTORS).catch(() => null);

    if (domState) {
      writeFileSync(dumpPath, JSON.stringify(domState, null, 2), "utf-8");
    }
    if (savedScreenshot || domState) {
      console.log(`📸 [Diagnostic Snapshot] Đã lưu snapshot tại: output/diagnostics/${stem}`);
    }
  } catch (diagErr) {
    console.warn("⚠️ Không thể lưu snapshot chẩn đoán:", diagErr);
  }
}

/**
 * Kiểm tra xem có nên bỏ qua việc xóa đoạn chat ChatGPT hay không.
 * Bảo vệ an toàn 100% dữ liệu của người dùng, không bao giờ xóa nhầm chat cũ.
 */
export function shouldSkipConversationDeletion(
  targetConvId: string | null,
  initialConvId: string | null,
  hasRunError: boolean,
  resultCount: number
): { shouldSkip: boolean; reason: "error_no_results" | "pre_existing_chat" | "no_valid_id" | null } {
  if (hasRunError && resultCount === 0) {
    return { shouldSkip: true, reason: "error_no_results" };
  }
  if (targetConvId && initialConvId && targetConvId === initialConvId) {
    return { shouldSkip: true, reason: "pre_existing_chat" };
  }
  if (!targetConvId) {
    return { shouldSkip: true, reason: "no_valid_id" };
  }
  return { shouldSkip: false, reason: null };
}

/**
 * Đánh giá điều kiện hoàn tất lượt sinh ảnh (kèm Settle Grace debounce 2.0s).
 * Tách biệt thành pure function để dễ dàng unit test cô lập.
 */
export function evaluateTurnCompletion(params: {
  newImagesCount: number;
  expectedCount: number;
  isGeneratingOrLoading: boolean;
  hasFinishedSignal: boolean;
  quietStartTime: number;
  currentTime?: number;
  settleGraceMs?: number;
}): {
  isComplete: boolean;
  isSettled: boolean;
  nextQuietStartTime: number;
} {
  const now = params.currentTime ?? Date.now();
  const settleGraceMs = params.settleGraceMs ?? 2_000;
  const hasNewImages = params.newImagesCount > 0;
  let nextQuietStartTime = params.quietStartTime;

  if (hasNewImages && !params.isGeneratingOrLoading) {
    if (nextQuietStartTime === 0) {
      nextQuietStartTime = now;
    }
  } else {
    nextQuietStartTime = 0;
  }

  const isSettled = nextQuietStartTime > 0 && now - nextQuietStartTime >= settleGraceMs;
  const isCompleteBatch = params.newImagesCount >= params.expectedCount;
  const isAssistantTurnFinished = (!params.isGeneratingOrLoading && params.hasFinishedSignal) || isSettled;

  const isComplete = hasNewImages && ((!params.isGeneratingOrLoading && isCompleteBatch) || isAssistantTurnFinished);

  return { isComplete, isSettled, nextQuietStartTime };
}

export interface ChatGPTPageState {
  isActivelyLoading: boolean;
  hasImageWidget: boolean;
  text: string;
  isOnline: boolean;
  errorMessage: string | null;
  hasRegenerateBtn: boolean;
  hasCompletionAction?: boolean;
  isGenerating?: boolean;
  currentImages?: string[];
}

export function inspectChatGPTPageState(
  docOrSelector?: any,
  navOrDoc?: any,
  imageSelector?: string,
  initialAssistantCount: number = 0
): ChatGPTPageState & { currentImages?: string[] } {
  let d: any;
  let n: any;
  let selector: string | undefined;
  let baselineAssistantCount = initialAssistantCount;

  if (
    typeof docOrSelector === "object" &&
    docOrSelector !== null &&
    ("imageSelector" in docOrSelector || "initialAssistantCount" in docOrSelector)
  ) {
    // Được gọi qua page.evaluate với payload: { imageSelector, initialAssistantCount }
    selector = docOrSelector.imageSelector;
    baselineAssistantCount = Number(docOrSelector.initialAssistantCount || 0);
    d = typeof document !== "undefined" ? document : null;
    n = typeof navigator !== "undefined" ? navigator : null;
  } else if (typeof docOrSelector === "string") {
    selector = docOrSelector;
    d = typeof document !== "undefined" ? document : null;
    n = typeof navigator !== "undefined" ? navigator : null;
    if (typeof navOrDoc === "number") {
      baselineAssistantCount = navOrDoc;
    }
  } else {
    d = docOrSelector || (typeof document !== "undefined" ? document : null);
    n = navOrDoc || (typeof navigator !== "undefined" ? navigator : null);
    selector = imageSelector;
    if (typeof initialAssistantCount === "number") {
      baselineAssistantCount = initialAssistantCount;
    }
  }

  if (!d) {
    return {
      isActivelyLoading: false,
      hasImageWidget: false,
      text: "",
      isOnline: true,
      errorMessage: null,
      hasRegenerateBtn: false,
      hasCompletionAction: false,
      isGenerating: false,
      currentImages: [],
    };
  }

  const isOnline = n && typeof n.onLine === "boolean" ? n.onLine : true;

  // Chỉ truy vấn đúng vai trò của assistant, loại bỏ .markdown tự do để tránh tóm nhầm tin nhắn của user
  const nodes = Array.from(
    d.querySelectorAll?.(
      '[data-message-author-role="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]'
    ) || []
  );
  // CHỐT CHẶN BẢO VỆ CHAT CŨ: Chỉ đánh giá lastTurn nếu xuất hiện assistant turn MỚI sau baseline ban đầu
  const hasNewAssistantTurn = nodes.length > baselineAssistantCount;
  const last: any = hasNewAssistantTurn && nodes.length > 0 ? nodes[nodes.length - 1] : null;
  const text = (last?.textContent || "").trim();

  // Scope lên đúng cấp turn: article hoặc conversation-turn bọc tin nhắn cuối
  const lastTurn: any = last?.closest?.('article, [data-testid^="conversation-turn-"]') || last;

  const mainChat: any = d.querySelector?.('main, [role="presentation"]') || d;

  // 1. Kiểm tra xem có spinner hoặc hiệu ứng loading đang xoay trong lượt chat cuối hoặc form chính hay không (tránh quét shimmer ở sidebar)
  const isActivelyLoading =
    (lastTurn !== null &&
      ((lastTurn.textContent || "").includes("Creating image") ||
       (lastTurn.textContent || "").includes("Generating image") ||
       lastTurn.querySelector?.(
         'svg.animate-spin, [class*="animate-spin"], [class*="shimmer"], [class*="spin"], [class*="loader"], [role="progressbar"], [aria-label*="Generating"], [aria-label*="Creating"]'
       ) !== null)) ||
    mainChat.querySelector?.(
      'form [aria-label*="Stop"], form [data-testid="stop-button"], main [aria-label*="Generating"], main [aria-label*="Creating"]'
    ) !== null;

  // 2. Kiểm tra xem lượt chat cuối có widget / container ảnh hay không (đồng bộ đầy đủ với CDN và định dạng ảnh của ChatGPT)
  const hasImageWidget = lastTurn
    ? lastTurn.querySelector?.(
        'div[data-testid*="image"], div[data-testid*="dalle"], div[class*="image-generation"], img[src*="estuary"], img[src*="files.oaiusercontent.com"], img[alt*="Generated image"], img[src*="oaidallea"], canvas'
      ) !== null
    : false;

  // 3. Tìm banner / thông báo lỗi đỏ từ ChatGPT
  let errorMessage: string | null = null;

  // 3.1 Kiểm tra modal / alert dialog toàn cục (chỉ bắt dialog đang mở/hiển thị, không bắt dialog ẩn/đóng)
  const modalDialogs = Array.from(
    d.querySelectorAll?.(
      '[role="dialog"]:not([aria-hidden="true"]):not([data-state="closed"]), [role="alertdialog"]:not([aria-hidden="true"]):not([data-state="closed"])'
    ) || []
  ) as HTMLElement[];
  const activeDialog = modalDialogs.find((dialog) => {
    if ((dialog as any).hidden) return false;
    if (typeof (dialog as any).checkVisibility === "function") {
      return (dialog as any).checkVisibility();
    }
    const style = (dialog as any).style;
    if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    return true;
  });
  if (activeDialog) {
    const modalText = ((activeDialog as any).textContent || "").trim();
    if (
      /session has expired|your session has expired|工作階段已過期|会话已过期|phiên đăng nhập đã hết hạn/i.test(
        modalText
      )
    ) {
      errorMessage = "Your session has expired. Please log in again.";
    } else if (
      /too many requests|rate limit|usage limit|generation limit/i.test(modalText)
    ) {
      errorMessage = modalText;
    }
  }

  // 3.2 Tìm banner lỗi trong turn hiện tại hoặc composer (giới hạn để không bắt nhầm lỗi từ các turn cũ)
  if (!errorMessage) {
    const errorScope = lastTurn || mainChat || d;
    const candidateNodes: any[] = Array.from(
      errorScope.querySelectorAll?.('[role="alert"], [class*="error"], [class*="danger"], .text-red-500') || []
    );
    if (lastTurn && mainChat) {
      const composerArea = d.querySelector?.('form, [data-testid="composer"]');
      if (composerArea && composerArea !== errorScope) {
        candidateNodes.push(
          ...Array.from(
            composerArea.querySelectorAll?.('[role="alert"], [class*="error"], [class*="danger"], .text-red-500') || []
          )
        );
      }
    }
    for (const el of candidateNodes) {
      const t = ((el as any).textContent || "").trim();
      if (
        t.includes("Something went wrong") ||
        t.includes("Network error") ||
        t.includes("error generating") ||
        t.includes("There was an error") ||
        t.includes("Unable to load") ||
        t.includes("Failed to load") ||
        t.includes("Rate limit") ||
        t.includes("limit of") ||
        t.includes("usage limit") ||
        t.includes("generation limit") ||
        t.includes("session has expired")
      ) {
        errorMessage = t;
        break;
      }
    }
  }

  // 4. Kiểm tra nút Regenerate xuất hiện ở lượt tin nhắn cuối (bao gồm cả icon button dùng aria-label)
  const hasRegenerateBtn = lastTurn
    ? lastTurn.querySelector?.(
        'button[data-testid*="regenerate"], button[data-testid*="refresh"], button[data-testid*="retry"], button[aria-label*="Regenerate" i], button[aria-label*="Try again" i], button[aria-label*="Retry" i]'
      ) !== null ||
      Array.from(lastTurn.querySelectorAll?.("button") || []).some((b: any) => {
        const txt = (b.textContent || "").trim().toLowerCase();
        const aria = (b.getAttribute?.("aria-label") || "").toLowerCase();
        return (
          txt.includes("regenerate") ||
          txt.includes("retry") ||
          aria.includes("regenerate") ||
          aria.includes("try again") ||
          aria.includes("retry")
        );
      })
    : false;

  // 4.1 Kiểm tra completionAction (nút Copy turn action hoặc các action button chỉ xuất hiện khi lượt sinh đã hoàn tất)
  const hasCompletionAction = lastTurn
    ? lastTurn.querySelector?.(
        'button[data-testid="copy-turn-action-button"], button[data-testid="good-response"], button[data-testid="bad-response"]'
      ) !== null
    : false;

  const isGenerating =
    mainChat.querySelector?.(
      'form [aria-label*="Stop"], form [data-testid="stop-button"], [data-testid="stop-button"]'
    ) !== null;

  let currentImages: string[] = [];
  if (selector) {
    currentImages = Array.from(d.querySelectorAll(selector))
      .filter((img: any) => !img.closest?.('[data-message-author-role="user"]') && !img.closest?.("form"))
      .map((img: any) => img.src || img.getAttribute?.("src") || "")
      .filter((src: string) => src.startsWith("http") || src.startsWith("blob:") || src.startsWith("data:"));
  }

  return { isActivelyLoading, hasImageWidget, text, isOnline, errorMessage, hasRegenerateBtn, hasCompletionAction, isGenerating, currentImages };
}

export async function generateImage(prompt: string, options: GenerateOptions = {}): Promise<DownloadResult[]> {
  if (options.signal?.aborted) {
    throw new Error("Quá trình sinh ảnh đã bị hủy bởi client (Client aborted request)");
  }

  if (!isSessionCached()) {
    throw new Error(
      "Phiên đăng nhập ChatGPT chưa có hoặc đã hết hạn. Vui lòng chạy 'chatgpt-image --login' hoặc bấm [🔑 Đăng nhập ChatGPT] trên WebUI để đăng nhập lại!"
    );
  }

  const inputImages = resolveInputImages(options.inputImages);
  for (const imgPath of inputImages) {
    validateInputImage(imgPath);
  }

  const shouldDeleteChat = resolveDeleteChatOption(options.deleteChatAfterGen);
  const { idleTimeoutMs, maxTimeoutMs } = resolveTimeoutOptions(options);
  const expectedCount = Math.max(1, options.expectedCount ?? 1);
  const session: BrowserSession = await getBrowserSession({
    headless: options.headless ?? false,
    browser: options.browser,
  });

  let abortedByClient = false;
  const abortHandler = () => {
    abortedByClient = true;
    // Thử click nút Stop nếu ChatGPT đang sinh dở để dừng tiến trình phía server OpenAI
    session.page
      .locator(SELECTORS.stopButton)
      .first()
      .click()
      .catch(() => {});
  };
  if (options.signal) {
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }

  let runError: any = null;
  let sessionStateSaved = false;
  let sessionRedirectError: string | null = null;
  let results: DownloadResult[] = [];
  let snapshotCaptured = false;

  try {
    const page = session.page;
    let capturedAuthHeader: string | null = null;
    let capturedAccountId: string | null = null;
    let detectedConversationId: string | null = null;
    let initialUrl = "";
    let initialConvId: string | null = null;

    const cleanupConversation = async () => {
      if (!shouldDeleteChat) return;
      if (page.isClosed()) return;
      try {
        let targetConvId = isValidConversationId(detectedConversationId) ? detectedConversationId : null;
        if (!targetConvId) {
          const urlMatch = page.url().match(/\/c\/([a-zA-Z0-9_-]+)/);
          targetConvId = urlMatch?.[1] && isValidConversationId(urlMatch[1]) ? urlMatch[1] : null;
        }

        const skipCheck = shouldSkipConversationDeletion(
          targetConvId,
          initialConvId,
          Boolean(runError),
          results.length
        );
        if (skipCheck.shouldSkip) {
          if (skipCheck.reason === "error_no_results") {
            console.log("ℹ️ Giữ lại phiên chat để kiểm tra do lượt sinh ảnh gặp lỗi.");
          } else if (skipCheck.reason === "pre_existing_chat") {
            console.log(`ℹ️ Bỏ qua không xóa chat ${targetConvId} vì đây là đoạn chat có sẵn từ trước.`);
          } else {
            console.log("ℹ️ Không tìm thấy ID đoạn chat hợp lệ trên URL để xóa.");
          }
          return;
        }

        if (targetConvId) {
          console.log(`🧹 Đang dọn dẹp (xóa) phiên chat trên ChatGPT (ID: ${targetConvId})...`);
          const deleteResult = await deleteChatGPTConversation(
            page,
            targetConvId,
            capturedAuthHeader,
            capturedAccountId
          );
          if (deleteResult.success) {
            console.log(`✅ Đã xóa chat ${targetConvId} thành công khỏi ChatGPT!`);
          } else if (deleteResult.status === 404) {
            console.log(`ℹ️ Phiên chat ${targetConvId} không tồn tại hoặc đã được xóa trước đó.`);
          } else {
            console.warn(
              `⚠️ Không thể xóa chat ${targetConvId} (HTTP ${deleteResult.status ?? "unknown"}${
                deleteResult.error ? `: ${deleteResult.error}` : ""
              })`
            );
          }
        }
      } catch (delErr) {
        console.warn("⚠️ Gặp lỗi khi dọn dẹp chat:", delErr instanceof Error ? delErr.message : delErr);
      }
    };

    const requestListener = (req: any) => {
      try {
        const urlStr = req.url();
        let parsed: URL;
        try {
          parsed = new URL(urlStr);
        } catch {
          return;
        }
        if (parsed.origin !== "https://chatgpt.com") return;
        if (parsed.pathname.startsWith("/backend-api/")) {
          const auth = req.headers()["authorization"];
          if (auth && !capturedAuthHeader) {
            capturedAuthHeader = auth;
          }
          const accountId = req.headers()["chatgpt-account-id"];
          if (accountId && !capturedAccountId) {
            capturedAccountId = accountId;
          }
          const match = parsed.pathname.match(/^\/backend-api\/conversation\/([a-zA-Z0-9_-]+)(?:\/|$)/);
          if (match && isValidConversationId(match[1]) && match[1] !== initialConvId && !detectedConversationId) {
            detectedConversationId = match[1];
          }
        }
      } catch {}
    };

    let cloudflareChallengeError: string | null = null;

    const responseListener = (res: any) => {
      try {
        const urlStr = res.url();
        let parsed: URL;
        try {
          parsed = new URL(urlStr);
        } catch {
          return;
        }
        if (parsed.origin !== "https://chatgpt.com") return;

        // Phát hiện Cloudflare challenge (403 + cf-mitigated: challenge)
        if (res.status() === 403 && res.headers?.()["cf-mitigated"] === "challenge") {
          cloudflareChallengeError =
            "ChatGPT bị chặn bởi Cloudflare WAF/Turnstile (cf-mitigated: challenge). Vui lòng thử lại sau hoặc đăng nhập lại qua trình duyệt thật.";
        }

        if (parsed.pathname.startsWith("/backend-api/conversation")) {
          const match = parsed.pathname.match(/^\/backend-api\/conversation\/([a-zA-Z0-9_-]+)(?:\/|$)/);
          if (match && isValidConversationId(match[1]) && match[1] !== initialConvId && !detectedConversationId) {
            detectedConversationId = match[1];
          }
        }
      } catch {}
    };

    page.on("request", requestListener);
    page.on("response", responseListener);
    page.on("framenavigated", (frame: any) => {
      try {
        if (frame === page.mainFrame()) {
          const currentUrl = frame.url();
          if (allowedAuthUrl(currentUrl)) {
            clearSessionVerified(false);
            sessionRedirectError =
              "Phiên đăng nhập ChatGPT đã hết hạn (bị chuyển hướng về trang đăng nhập). Vui lòng đăng nhập lại!";
          }
          const match = currentUrl.match(/\/c\/([a-zA-Z0-9_-]+)/);
          if (match && isValidConversationId(match[1]) && match[1] !== initialConvId && !detectedConversationId) {
            detectedConversationId = match[1];
          }
        }
      } catch {}
    });

    try {
      if (options.signal?.aborted) {
        throw new Error("Quá trình sinh ảnh đã bị hủy bởi client (Client aborted request)");
      }

      // Lưu ý quan trọng: ChatGPT Web KHÔNG hỗ trợ tạo ảnh trong Temporary Chat (?temporary-chat=true).
      // Luôn truy cập CHATGPT_URL thông thường để đảm bảo công cụ vẽ ảnh khả dụng 100%.
      // Nếu bật deleteChatAfterGen, phiên chat sẽ được dọn dẹp an toàn qua API sau khi tải ảnh xong.
      const targetUrl = CHATGPT_URL;
      console.log(`[1/5] Đang mở ChatGPT Web (${targetUrl})...`);
      await raceWithAbort(
        page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }),
        options.signal
      );
      initialUrl = page.url();
      const initMatch = initialUrl.match(/\/c\/([a-zA-Z0-9_-]+)/);
      if (initMatch?.[1] && isValidConversationId(initMatch[1])) {
        initialConvId = initMatch[1];
      }

      // 1. Kiểm tra session redirect / hết hạn phiên trước
      if (sessionRedirectError || allowedAuthUrl(page.url())) {
        clearSessionVerified(false);
        throw new Error(
          sessionRedirectError ||
            "Phiên đăng nhập ChatGPT đã hết hạn (bị chuyển hướng về trang đăng nhập). Vui lòng đăng nhập lại!"
        );
      }

      // 2. Kiểm tra Cloudflare WAF / Turnstile challenge ngay lập tức (fail-fast <500ms)
      const pageTitle = await page.title().catch(() => "");
      const isCloudflareChallenge =
        Boolean(cloudflareChallengeError) ||
        pageTitle.includes("Just a moment...") ||
        pageTitle.includes("Attention Required") ||
        (await page
          .locator('#challenge-running, #challenge-stage, #challenge-form, .cf-turnstile, iframe[src*="cloudflare"]')
          .first()
          .isVisible()
          .catch(() => false));

      if (isCloudflareChallenge) {
        throw new Error(
          cloudflareChallengeError ||
            "ChatGPT bị chặn bởi Cloudflare WAF/Turnstile. Vui lòng thử lại sau hoặc đăng nhập lại qua trình duyệt thật."
        );
      }

      // 3. Kiểm tra Origin an toàn (sau khi đã loại trừ session redirect hợp lệ)
      if (new URL(page.url()).origin !== "https://chatgpt.com") {
        throw new Error(`Chuyển hướng đến nguồn không an toàn hoặc không xác định: ${page.url()}`);
      }

      if (options.signal?.aborted) {
        throw new Error("Quá trình sinh ảnh đã bị hủy bởi client (Client aborted request)");
      }

      await dismissCookieBannerIfPresent(page);
      await dismissChatGptModalsAndOnboarding(page);

      // Kiểm tra trạng thái đăng nhập dương tính
      const loggedIn = await checkIsLoggedIn(page);

      if (!loggedIn) {
        clearSessionVerified(false);
        throw new Error(
          "Phiên đăng nhập ChatGPT chưa có hoặc đã hết hạn. Vui lòng chạy 'chatgpt-image --login' hoặc bấm [🔑 Đăng nhập ChatGPT] trên WebUI để đăng nhập lại!"
        );
      }

      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);

      if (options.signal?.aborted) {
        throw new Error("Quá trình sinh ảnh đã bị hủy bởi client (Client aborted request)");
      }

      // Đợi ô nhập liệu hiển thị
      console.log("[2/5] Đang đợi ô soạn thảo prompt sẵn sàng...");
      const composer = page.locator(SELECTORS.composer).first();
      await raceWithAbort(
        composer.waitFor({ state: "visible", timeout: 30_000 }),
        options.signal
      );

    if (inputImages.length > 0) {
      // Đợi 2s cho React hydrate xong và cắm event listener vào thẻ input file
      await page.waitForTimeout(2_000);
      console.log(`[2.5/5] Đang nạp ${inputImages.length} ảnh tham chiếu vào DOM...`);
      await attachImagesToChatGPT(page, inputImages);
    }

    // Lưu danh sách URL ảnh cũ trước khi gửi prompt (loại trừ user message và form để không dính ảnh tham chiếu)
    const initialUrls = await page.evaluate((selector) => {
      return Array.from(document.querySelectorAll<HTMLImageElement>(selector))
        .filter((img) => !img.closest('[data-message-author-role="user"]') && !img.closest("form"))
        .map((img) => img.src || img.getAttribute("src") || "")
        .filter((src) => src.length > 0);
    }, SELECTORS.generatedImage);

    console.log(`[3/5] Đang nhập prompt: "${prompt}"...`);
    await page.bringToFront().catch(() => {});
    await composer.click({ force: true }).catch(() => {});
    await page.keyboard.press("ControlOrMeta+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});

    const inserted = await composer.evaluate(insertPlainTextIntoComposer, prompt).catch(() => false);
    if (!inserted) {
      try {
        await page.keyboard.insertText(prompt);
      } catch {
        await composer.fill(prompt);
      }
    }
    await composer
      .evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })
      .catch(() => {});

    // Bắt baseline số lượng assistant turn trước khi gửi prompt để chống fail-fast nhầm trên chat cũ
    const initialAssistantCount = await page
      .locator(
        '[data-message-author-role="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]'
      )
      .count()
      .catch(() => 0);

    // Lưu URL trước khi gửi prompt và đồng bộ lại initialConvId nếu trang vừa điều hướng / khôi phục chat cũ
    // Tránh xoá nhầm các đoạn chat cũ từ sidebar hoặc trang tải ban đầu
    initialUrl = page.url();
    const preSendMatch = initialUrl.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (preSendMatch?.[1] && isValidConversationId(preSendMatch[1])) {
      initialConvId = preSendMatch[1];
    }
    detectedConversationId = null;

    // Gửi prompt: Luôn luôn đợi nút Send chuyển sang trạng thái ENABLED cho MỌI request (cả text-only lẫn image)
    await page.waitForTimeout(400);
    const sendBtn = page.locator(SELECTORS.sendButton).first();
    const sendTimeout = inputImages.length > 0 ? 20_000 : 10_000;
    try {
      await sendBtn.waitFor({ state: "visible", timeout: sendTimeout });
      // BẮT BUỘC: Đợi nút Send hết disabled và aria-disabled !== "true"
      await page.waitForFunction(
        (sel) => {
          const btn = document.querySelector(sel);
          return Boolean(btn && !btn.hasAttribute("disabled") && btn.getAttribute("aria-disabled") !== "true");
        },
        SELECTORS.sendButton,
        { timeout: sendTimeout }
      );
      await sendBtn.click({ timeout: 5_000 });
    } catch {
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptRateLimitDialog(page);
      // Fallback: Thử bấm phím Enter và kích hoạt click DOM trực tiếp nếu Playwright actionability bị nghẽn
      await composer.focus().catch(() => {});
      await composer.press("Enter").catch(() => {});
      await page
        .evaluate((sel) => {
          const btn = document.querySelector<HTMLElement>(sel);
          if (btn && !btn.hasAttribute("disabled") && btn.getAttribute("aria-disabled") !== "true") {
            btn.click();
          }
        }, SELECTORS.sendButton)
        .catch(() => {});
    }

    // Đợi 1500ms cho ChatGPT nhận lệnh và bắt đầu streaming
    await page.waitForTimeout(1500);

    // Đợi nút Stop xuất hiện biểu thị ChatGPT đã bắt đầu xử lý request
    await page.locator(SELECTORS.stopButton).first().waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});

    // [VÒNG LẶP CHÍNH]: Giám sát quá trình sinh ảnh với Inactivity Timeout & Max Timeout
    console.log(`[3/5] Đang giám sát ChatGPT Web (Kỳ vọng: ${expectedCount} ảnh | Idle Timeout: ${Math.round(idleTimeoutMs / 1000)}s)...`);
    const startTime = Date.now();
    let lastActivityTime = Date.now();
    let lastLoggedTime = Date.now();
    let previousImageCount = initialUrls.length;
    let previousTextLength = 0;
    let success = false;
    const knownSet = new Set(initialUrls);
    const knownKeys = new Set(initialUrls.map(extractImageKey));
    let consecutiveObservationFaults = 0;
    let quietStartTime = 0;

    while (Date.now() - startTime < maxTimeoutMs) {
      if (abortedByClient || options.signal?.aborted) {
        throw new Error("Quá trình sinh ảnh đã bị hủy bởi client (Client aborted request)");
      }

      if (cloudflareChallengeError) {
        throw new Error(cloudflareChallengeError);
      }

      if (sessionRedirectError) {
        throw new Error(sessionRedirectError);
      }
      if (allowedAuthUrl(page.url())) {
        clearSessionVerified(false);
        throw new Error(
          "Phiên đăng nhập ChatGPT đã hết hạn (bị chuyển hướng về trang đăng nhập). Vui lòng đăng nhập lại!"
        );
      }

      if (!detectedConversationId) {
        const match = page.url().match(/\/c\/([a-zA-Z0-9_-]+)/);
        if (match?.[1] && isValidConversationId(match[1]) && match[1] !== initialConvId) {
          detectedConversationId = match[1];
        }
      }

      let pageState: ChatGPTPageState & { currentImages?: string[] };
      try {
        pageState = await page.evaluate(inspectChatGPTPageState, {
          imageSelector: SELECTORS.generatedImage,
          initialAssistantCount,
        });
        consecutiveObservationFaults = 0;
      } catch (evalErr: any) {
        consecutiveObservationFaults++;
        if (consecutiveObservationFaults > 5) {
          throw evalErr;
        }
        await page.waitForTimeout(600);
        continue;
      }

      const currentImages = pageState.currentImages || [];

      const currentKeyMap = new Map<string, string>();
      for (const src of currentImages) {
        const key = extractImageKey(src);
        if (!currentKeyMap.has(key)) {
          currentKeyMap.set(key, src);
        }
      }
      const newImages = Array.from(currentKeyMap.values()).filter(
        (src) => !knownSet.has(src) && !knownKeys.has(extractImageKey(src))
      );
      const hasNewImages = newImages.length > 0;
      const isGenerating = Boolean(pageState.isGenerating);

      // Fail-fast mạng: Trình duyệt mất kết nối Internet
      if (!pageState.isOnline) {
        throw new Error("Trình duyệt mất kết nối Internet (navigator.onLine = false).");
      }

      // Fail-fast lỗi giao diện: ChatGPT hiển thị banner hoặc modal dialog
      if (pageState.errorMessage) {
        await throwIfChatGptSessionFailureAlert(page);
        await throwIfChatGptRateLimitDialog(page);
        if (newImages.length === 0) {
          const cleanErr = pageState.errorMessage.length > 150 ? pageState.errorMessage.slice(0, 150) + "..." : pageState.errorMessage;
          throw new Error(`ChatGPT báo lỗi: "${cleanErr}"`);
        }
      }

      // Reset Inactivity Timer khi có bất kỳ tín hiệu đang tạo ảnh nào từ ChatGPT
      if (
        isGenerating ||
        pageState.isActivelyLoading ||
        currentImages.length > previousImageCount ||
        pageState.text.length > previousTextLength
      ) {
        lastActivityTime = Date.now();
      }
      if (currentImages.length > previousImageCount) {
        previousImageCount = currentImages.length;
      }
      if (pageState.text.length > previousTextLength) {
        previousTextLength = pageState.text.length;
      }

      // Điều kiện hoàn tất: Đã đủ số lượng ảnh mong đợi HOẶC ChatGPT đã thực sự dừng sinh hoàn toàn
      const isGeneratingOrLoading = isGenerating || pageState.isActivelyLoading;
      const hasFinishedSignal = Boolean(pageState.hasCompletionAction || pageState.hasRegenerateBtn);

      const turnEval = evaluateTurnCompletion({
        newImagesCount: newImages.length,
        expectedCount,
        isGeneratingOrLoading,
        hasFinishedSignal,
        quietStartTime,
      });
      quietStartTime = turnEval.nextQuietStartTime;

      if (turnEval.isComplete) {
        success = true;
        // Đợi 500ms cho các thẻ DOM render hoàn tất
        await page.waitForTimeout(500);
        break;
      }

      // Fail-fast: Nút Stop đã tắt, không có spinner đang tải, không có widget ảnh ở turn cuối, có tín hiệu xong (Regenerate hoặc Completion) nhưng không có ảnh mới
      if (
        !isGenerating &&
        !pageState.isActivelyLoading &&
        !pageState.hasImageWidget &&
        hasFinishedSignal &&
        !hasNewImages &&
        Date.now() - startTime > 5000
      ) {
        if (pageState.text) {
          const preview = pageState.text.length > 120 ? pageState.text.slice(0, 120) + "..." : pageState.text;
          throw new Error(`ChatGPT không tạo ảnh mà trả lời bằng văn bản: "${preview}"`);
        }
        throw new Error("ChatGPT đã dừng quá trình tạo nhưng không sinh ra ảnh mới nào.");
      }

      // In nhật ký nhịp tim (Heartbeat log) mỗi 15s nếu tác vụ đang chạy lâu
      if (Date.now() - lastLoggedTime >= 15_000) {
        lastLoggedTime = Date.now();
        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        const idleSec = Math.round((Date.now() - lastActivityTime) / 1000);
        const newCount = newImages.length;
        console.log(
          `⏳ [Bridge] Đang sinh ảnh... (Đã chạy: ${elapsedSec}s | Hoạt động gần nhất: ${idleSec}s trước | Đã tìm thấy: ${newCount} ảnh mới)`
        );
      }

      // Kiểm tra Inactivity Timeout (ChatGPT đơ/bất động không có hoạt động mới)
      if (Date.now() - lastActivityTime > idleTimeoutMs) {
        if (hasNewImages) {
          console.warn(
            `⚠️ [Bridge] Hết thời gian chờ bất động (${idleTimeoutMs / 1000}s) nhưng đã tạo được ${newImages.length} ảnh mới. Trả về ảnh đã có cho client thay vì huỷ toàn bộ.`
          );
          success = true;
          await page.waitForTimeout(1000);
          break;
        }
        if (!snapshotCaptured) {
          await captureDiagnosticSnapshot(page, "idle_timeout").catch(() => {});
          snapshotCaptured = true;
        }
        throw new Error(
          `Quá thời gian chờ bất động (${idleTimeoutMs / 1000}s) do không phát hiện hoạt động mới từ ChatGPT. (Tổng thời gian đã chờ: ${Math.round((Date.now() - startTime) / 1000)}s)`
        );
      }

      await page.waitForTimeout(400);
    }

    if (!success) {
      if (!snapshotCaptured) {
        await captureDiagnosticSnapshot(page, "max_timeout").catch(() => {});
        snapshotCaptured = true;
      }
      throw new Error(`Quá thời gian chờ tối đa (${maxTimeoutMs / 1000}s) nhưng không thấy ảnh mới được sinh ra.`);
    }

    // Đồng bộ session state ngay khi turn thành công để lưu trữ token đã xoay vòng
    try {
      await saveSanitizedStorageState(session.context);
      sessionStateSaved = true;
    } catch {}

    // Tải và lưu toàn bộ ảnh về đĩa
    const defaultOut = `./output/image_${Date.now()}.png`;
    const targetOut = options.outputPath || defaultOut;
    console.log(`[5/5] Đã phát hiện ảnh mới! Đang trích xuất ảnh...`);

    results = await extractAndSaveImages(page, SELECTORS.generatedImage, targetOut, {
      knownUrls: initialUrls,
      skipDiskWrite: options.skipDiskWrite,
    });
  } catch (err) {
    runError = err;
    const isClientAbort = Boolean(
      abortedByClient ||
      options.signal?.aborted ||
      (err instanceof Error && err.message.includes("Client aborted"))
    );
    if (!snapshotCaptured && !isClientAbort) {
      await captureDiagnosticSnapshot(session.page, "error").catch(() => {});
      snapshotCaptured = true;
    }
  }

  if (shouldDeleteChat) {
    await cleanupConversation();
  } else {
    console.log("ℹ️ Giữ lại đoạn chat trên ChatGPT Web theo tùy chọn của người dùng.");
  }

  if (runError) {
    if (options.signal?.aborted) {
      throw new Error("Quá trình sinh ảnh đã bị hủy bởi client (Client aborted request)");
    }
    throw runError;
  }

  return results;
} finally {
  try {
    if (!runError && !sessionStateSaved && !sessionRedirectError && !session.page.isClosed()) {
      await saveSanitizedStorageState(session.context);
      sessionStateSaved = true;
    }
  } catch {}
  if (options.signal) {
    options.signal.removeEventListener("abort", abortHandler);
  }
  await session.close();
}
}

export async function deleteChatGPTConversation(
  page: Page,
  conversationId: string,
  authHeader?: string | null,
  accountId?: string | null
): Promise<{ success: boolean; status?: number; error?: string }> {
  const cleanId = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!isValidConversationId(cleanId)) {
    return { success: false, error: "ID đoạn chat không hợp lệ (Invalid conversation ID format)" };
  }
  try {
    const result = await page.evaluate(
      async ({ id, auth, accountId }: { id: string; auth: string | null; accountId: string | null }) => {
        let timer: any;
        try {
          if (location.origin !== "https://chatgpt.com") {
            return { success: false, error: "Invalid execution origin (Must be https://chatgpt.com)" };
          }
          const controller = new AbortController();
          timer = setTimeout(() => controller.abort(), 15000);
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (auth) {
            headers["Authorization"] = auth;
          } else {
            try {
              const sessionRes = await fetch("/api/auth/session", {
                credentials: "include",
                signal: controller.signal,
              });
              if (sessionRes.ok) {
                const sessionData = (await sessionRes.json()) as { accessToken?: string };
                if (sessionData?.accessToken) {
                  headers["Authorization"] = `Bearer ${sessionData.accessToken}`;
                }
              }
            } catch {}
          }

          if (accountId) {
            headers["chatgpt-account-id"] = accountId;
          }

          const res = await fetch(`/backend-api/conversation/${id}`, {
            method: "PATCH",
            headers,
            credentials: "include",
            body: JSON.stringify({ is_visible: false }),
            signal: controller.signal,
          });

          let errorDetail: string | undefined;
          if (!res.ok) {
            try {
              const rawText = await res.text().catch(() => undefined);
              if (rawText) {
                try {
                  const errJson = JSON.parse(rawText);
                  const d = errJson?.detail;
                  errorDetail = typeof d === "string" ? d : JSON.stringify(d ?? errJson);
                } catch {
                  errorDetail = rawText.slice(0, 500);
                }
              }
            } catch {
              errorDetail = undefined;
            }
          }

          return { success: res.ok, status: res.status, error: errorDetail };
        } catch (err) {
          return { success: false, error: String(err) };
        } finally {
          if (timer) clearTimeout(timer);
        }
      },
      { id: cleanId, auth: authHeader || null, accountId: accountId || null }
    );
    return result;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
