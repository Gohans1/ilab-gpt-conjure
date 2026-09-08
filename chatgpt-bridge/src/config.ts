import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import crypto from "node:crypto";

const atomicWaitCell = new Int32Array(new SharedArrayBuffer(4));
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 150, 250, 350, 500] as const;

export function renameAtomicFile(source: string, destination: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transientWindowsError =
        process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (!transientWindowsError || delay === undefined) throw error;
      try {
        Atomics.wait(atomicWaitCell, 0, 0, delay);
      } catch {
        const deadline = Date.now() + delay;
        while (Date.now() < deadline) {}
      }
    }
  }
}

export function atomicWriteFile(path: string, data: string | Uint8Array): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {}
  const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, data);
    closeSync(fd);
    renameAtomicFile(temp, path);
    try {
      chmodSync(path, 0o600);
    } catch {}
  } catch (error) {
    try {
      closeSync(fd);
    } catch {}
    rmSync(temp, { force: true });
    throw error;
  }
}

export const CHATGPT_URL = "https://chatgpt.com/";
// Lưu ý: ChatGPT Web KHÔNG hỗ trợ công cụ vẽ ảnh (DALL-E / Imagen) trên Temporary Chat (?temporary-chat=true).
// Luôn sử dụng CHATGPT_URL chính để sinh ảnh và dọn dẹp bằng API xóa hội thoại nếu cần xóa.
export const CHATGPT_TEMPORARY_CHAT_URL = "https://chatgpt.com/?temporary-chat=true";
export const CHATGPT_LOGIN_URL = "https://chatgpt.com/auth/login";

export function getSafeShortPath(targetPath: string): string {
  if (process.platform !== "win32" || !targetPath.includes(" ")) {
    return targetPath;
  }
  try {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const escaped = targetPath.replace(/'/g, "''");
    const result = spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `$f = (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${escaped}'); if ($f) { $f.ShortPath } else { '${escaped}' }`,
      ],
      { encoding: "utf8", timeout: 3000, windowsHide: true }
    );
    const shortPath = (result.stdout || "").trim();
    if (shortPath && !shortPath.includes(" ") && existsSync(shortPath)) {
      return shortPath;
    }
  } catch {}
  return targetPath;
}

export interface BrowserCandidatesResult {
  primary: string[];
  fallback: string[];
  selectedBrowser: "chrome" | "edge";
  actualBrowser: "chrome" | "edge";
  fallbackUsed: boolean;
  preferredBrowser?: "chrome" | "edge";
  availableBrowsers: {
    edge: boolean;
    chrome: boolean;
  };
}

let cachedAvailableBrowsers: { edge: boolean; chrome: boolean; expires: number } | null = null;
export function getAvailableBrowsers(): { edge: boolean; chrome: boolean } {
  const now = Date.now();
  if (!cachedAvailableBrowsers || now > cachedAvailableBrowsers.expires) {
    const res = findBrowserCandidates();
    cachedAvailableBrowsers = {
      edge: res.availableBrowsers.edge,
      chrome: res.availableBrowsers.chrome,
      expires: now + 30_000,
    };
  }
  return { edge: cachedAvailableBrowsers.edge, chrome: cachedAvailableBrowsers.chrome };
}

function isExecutableFile(p: string): boolean {
  if (!p) return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function findBrowserCandidates(preferredBrowser?: "chrome" | "edge" | string): BrowserCandidatesResult {
  const cleanEnvPath = (val?: string) => (val ? val.trim().replace(/^["'](.*)["']$/, "$1").trim() : "");
  const localAppData = process.platform === "win32" && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : "";
  const progFiles =
    process.platform === "win32" && process.env.ProgramFiles ? process.env.ProgramFiles : "C:\\Program Files";
  const progFilesX86 =
    process.platform === "win32" && process.env["ProgramFiles(x86)"]
      ? process.env["ProgramFiles(x86)"]
      : "C:\\Program Files (x86)";

  const chromeCandidates = Array.from(
    new Set(
      [
        cleanEnvPath(process.env.CHROME_PATH),
        // Windows dynamic env paths
        join(progFiles, "Google\\Chrome\\Application\\chrome.exe"),
        join(progFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
        localAppData ? join(localAppData, "Google\\Chrome\\Application\\chrome.exe") : "",
        // Windows standard hardcoded
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        // macOS
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        // Linux
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ].filter(isExecutableFile)
    )
  );

  const edgeCandidates = Array.from(
    new Set(
      [
        cleanEnvPath(process.env.EDGE_PATH),
        // Windows dynamic env paths
        join(progFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
        join(progFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
        localAppData ? join(localAppData, "Microsoft\\Edge\\Application\\msedge.exe") : "",
        // Windows standard hardcoded
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        // macOS
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        // Linux
        "/usr/bin/microsoft-edge",
      ].filter(isExecutableFile)
    )
  );

  const availableBrowsers = {
    edge: edgeCandidates.length > 0,
    chrome: chromeCandidates.length > 0,
  };

  const pref = (preferredBrowser || process.env.CHATGPT_BROWSER || "").toLowerCase().trim().replace(/\.exe$/, "");
  const isExplicitEdge = pref === "edge" || pref === "msedge";
  const isExplicitChrome = pref === "chrome" || pref === "google-chrome" || pref === "chromium";

  if (isExplicitEdge) {
    const fallbackUsed = edgeCandidates.length === 0 && chromeCandidates.length > 0;
    const actualBrowser = edgeCandidates.length > 0 ? "edge" : (chromeCandidates.length > 0 ? "chrome" : "edge");
    return {
      primary: edgeCandidates,
      fallback: chromeCandidates,
      selectedBrowser: "edge",
      actualBrowser,
      fallbackUsed,
      preferredBrowser: "edge",
      availableBrowsers,
    };
  }

  if (isExplicitChrome) {
    const fallbackUsed = chromeCandidates.length === 0 && edgeCandidates.length > 0;
    const actualBrowser = chromeCandidates.length > 0 ? "chrome" : (edgeCandidates.length > 0 ? "edge" : "chrome");
    return {
      primary: chromeCandidates,
      fallback: edgeCandidates,
      selectedBrowser: "chrome",
      actualBrowser,
      fallbackUsed,
      preferredBrowser: "chrome",
      availableBrowsers,
    };
  }

  // Mặc định khi không chỉ định: ưu tiên Edge nếu có (chuẩn Windows), nếu không thì dùng Chrome
  const hasEdge = edgeCandidates.length > 0;
  const hasChrome = chromeCandidates.length > 0;
  const actualBrowser = hasEdge ? "edge" : (hasChrome ? "chrome" : "edge");
  return {
    primary: hasEdge ? edgeCandidates : chromeCandidates,
    fallback: hasEdge ? chromeCandidates : [],
    selectedBrowser: actualBrowser,
    actualBrowser,
    fallbackUsed: false,
    preferredBrowser: actualBrowser,
    availableBrowsers,
  };
}

function resolveProfileDir(): string {
  if (process.env.CHATGPT_PROFILE_DIR) {
    return process.env.CHATGPT_PROFILE_DIR;
  }
  const repoData = resolve(import.meta.dirname, "../../data");
  if (existsSync(repoData) || existsSync(resolve(import.meta.dirname, "../../Start-All.bat"))) {
    return join(repoData, "chatgpt-profile");
  }
  const bridgeData = resolve(import.meta.dirname, "../data");
  if (existsSync(bridgeData)) {
    return join(bridgeData, "chatgpt-profile");
  }
  return join(homedir(), ".chatgpt-image-cli", "profile");
}

export const USER_DATA_DIR = resolveProfileDir();
export const STORAGE_STATE_PATH = join(USER_DATA_DIR, "storage-state.json");

export const SELECTORS = {
  composer: '#prompt-textarea, [data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"], div[contenteditable="true"]',
  sendButton: '[data-testid="send-button"]',
  stopButton: 'form [aria-label*="Stop" i], button[aria-label*="Stop" i], form [data-testid="stop-button"], [data-testid="stop-button"]',
  completionAction: 'button[data-testid="copy-turn-action-button"], button[data-testid="good-response"], button[data-testid="bad-response"]',
  regenerateButton: 'button[data-testid*="regenerate"], button[data-testid*="refresh"], button[data-testid*="retry"], button[aria-label*="Regenerate" i], button[aria-label*="Try again" i], button[aria-label*="Retry" i]',
  generatedImage: '[data-message-author-role="assistant"] img[src*="backend-api/estuary"], [data-message-author-role="assistant"] img[src*="files.oaiusercontent.com"], [data-message-author-role="assistant"] img[alt*="Generated image"], [data-message-author-role="assistant"] img[src*="oaidallea"], [data-testid*="conversation-turn"] [data-message-author-role="assistant"] img, img[src*="backend-api/estuary"]',
  loginButton: 'button[data-testid="login-button"], a[href*="/auth/login"], button:has-text("Log in"), button:has-text("Đăng nhập"), button:has-text("ログイン"), button:has-text("登录"), a:has-text("Log in"), a:has-text("Đăng nhập")',
  fileInput: 'input#upload-photos[type="file"], input#upload-files[type="file"], input[type="file"]',
  attachButton: 'button[data-testid*="plus"], button[data-testid*="attach"], button[aria-label*="Add files" i], button[aria-label*="Attach" i]',
  attachmentThumbnail: 'form img[src^="blob:"], form button[aria-label*="Remove file" i], button[aria-label*="Remove file" i], form button[aria-label*="Remove" i], [data-testid*="attachment"], [data-testid*="file-pill"], [class*="attachment"], [class*="file-item"]',
  attachmentUploading: 'form [data-testid*="upload-progress"], form [aria-label*="Uploading" i], [data-testid*="attachment"] .animate-spin, form .animate-spin',
  assistantTurn: '[data-message-author-role="assistant"], [data-testid^="conversation-turn-"]',
  userTurn: '[data-message-author-role="user"]',
};

/**
 * Danh mục selector tham khảo (Bookmark) từ dự án miuuyy/codex-chatgpt-web.
 * Lưu trữ dự phòng cho các tính năng Text / Reasoning / Model Switching trong tương lai.
 */
export const CODEX_REFERENCE_SELECTORS = {
  effortControl: [
    'button[aria-haspopup="menu"][data-tone="neutral"]',
    'button[data-testid="model-switcher-dropdown-button"][aria-haspopup="menu"]',
  ].join(", "),
  effortMenu: [
    '[data-testid="composer-intelligence-picker-content"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
    '[role="menu"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
    '[role="group"]:has([role="menuitemradio"], [data-model-reasoning-effort-slider])',
  ].join(", "),
  effortItem: '[role="menuitemradio"]',
  effortSliderContainer: '[data-model-reasoning-effort-slider]',
  effortSlider: '[data-model-reasoning-effort-slider] [role="slider"]',
  modelSwitcher: 'button[data-testid="model-switcher-dropdown-button"]',
  copyAction: 'button[data-testid="copy-turn-action-button"]',
  assistantTurn: [
    '[data-testid^="conversation-turn-"][data-turn="assistant"]',
    '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"])',
  ].join(", "),
  userTurn: [
    '[data-testid^="conversation-turn-"][data-turn="user"]',
    '[data-testid^="conversation-turn-"][data-message-author-role="user"]',
    '[data-testid^="conversation-turn-"]:has([data-message-author-role="user"])',
  ].join(", "),
};

export function detectImageExtension(buf: Buffer | Uint8Array): string | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return ".png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return ".jpg";
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return ".gif";
  }
  if (
    buf.length >= 12 &&
    Buffer.from(buf).toString("ascii", 0, 4) === "RIFF" &&
    Buffer.from(buf).toString("ascii", 8, 12) === "WEBP"
  ) {
    return ".webp";
  }
  return null;
}
