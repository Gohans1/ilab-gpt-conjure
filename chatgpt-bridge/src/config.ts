import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
export const CHATGPT_LOGIN_URL = "https://chatgpt.com/auth/login";

export function findBrowserCandidates(): { primary: string[]; fallback: string[] } {
  const localAppData = process.platform === "win32" && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : "";
  const primaryCandidates = Array.from(
    new Set(
      [
        process.env.CHROME_PATH || "",
        // Windows
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        localAppData ? join(localAppData, "Google\\Chrome\\Application\\chrome.exe") : "",
        // macOS
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        // Linux
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ].filter((p) => Boolean(p && existsSync(p)))
    )
  );

  const fallbackCandidates = Array.from(
    new Set(
      [
        process.env.EDGE_PATH || "",
        // Windows
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        localAppData ? join(localAppData, "Microsoft\\Edge\\Application\\msedge.exe") : "",
        // macOS
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        // Linux
        "/usr/bin/microsoft-edge",
      ].filter((p) => Boolean(p && existsSync(p)))
    )
  );

  return { primary: primaryCandidates, fallback: fallbackCandidates };
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
  composer: '#prompt-textarea, div[contenteditable="true"], [data-testid="prompt-textarea"]',
  sendButton: '[data-testid="send-button"]',
  stopButton: '[data-testid="stop-button"]',
  generatedImage: '[data-message-author-role="assistant"] img[src*="backend-api/estuary"], [data-message-author-role="assistant"] img[src*="files.oaiusercontent.com"], [data-message-author-role="assistant"] img[alt*="Generated image"], [data-message-author-role="assistant"] img[src*="oaidalleapiprodscus"], [data-testid*="conversation-turn"] [data-message-author-role="assistant"] img, img[src*="backend-api/estuary"]',
  loginButton: 'button[data-testid="login-button"], a[href*="/auth/login"], button:has-text("Log in"), button:has-text("Đăng nhập"), a:has-text("Log in"), a:has-text("Đăng nhập")',
  fileInput: 'input#upload-photos[type="file"], input#upload-files[type="file"], input[type="file"]',
  attachButton: 'button[data-testid*="plus"], button[data-testid*="attach"], button[aria-label*="Add files" i], button[aria-label*="Attach" i]',
  attachmentThumbnail: 'form img[src^="blob:"], form button[aria-label*="Remove file" i], button[aria-label*="Remove file" i], form button[aria-label*="Remove" i], [data-testid*="attachment"], [data-testid*="file-pill"], [class*="attachment"], [class*="file-item"]',
  attachmentUploading: 'form [data-testid*="upload-progress"], form [aria-label*="Uploading" i], [data-testid*="attachment"] .animate-spin, form .animate-spin',
};
