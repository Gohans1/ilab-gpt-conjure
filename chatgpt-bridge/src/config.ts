import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CHATGPT_URL = "https://chatgpt.com/";

function findChromePath(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidatePaths = [
    // Google Chrome
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    // Microsoft Edge
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    join(process.env.LOCALAPPDATA || "", "Microsoft\\Edge\\Application\\msedge.exe"),
  ];
  for (const path of candidatePaths) {
    if (existsSync(path)) return path;
  }
  return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
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

export const CHROME_EXECUTABLE_PATH = findChromePath();
export const USER_DATA_DIR = resolveProfileDir();

export const SELECTORS = {
  composer: '#prompt-textarea, div[contenteditable="true"], [data-testid="prompt-textarea"]',
  sendButton: '[data-testid="send-button"]',
  stopButton: '[data-testid="stop-button"]',
  generatedImage: '[data-message-author-role="assistant"] img[src*="backend-api/estuary"], [data-message-author-role="assistant"] img[src*="files.oaiusercontent.com"], [data-message-author-role="assistant"] img[alt*="Generated image"], [data-message-author-role="assistant"] img[src*="oaidalleapiprodscus"], [data-testid*="conversation-turn"] [data-message-author-role="assistant"] img, img[src*="backend-api/estuary"]',
  loginButton: 'button[data-testid="login-button"], a[href*="/auth/login"]',
  fileInput: 'input#upload-photos[type="file"], input#upload-files[type="file"], input[type="file"]',
  attachButton: 'button[data-testid*="plus"], button[data-testid*="attach"], button[aria-label*="Add files" i], button[aria-label*="Attach" i]',
  attachmentThumbnail: 'form img[src^="blob:"], form button[aria-label*="Remove file" i], button[aria-label*="Remove file" i], form button[aria-label*="Remove" i], [data-testid*="attachment"], [data-testid*="file-pill"], [class*="attachment"], [class*="file-item"], button[aria-label*="Remove" i]',
  attachmentUploading: 'form [data-testid*="upload-progress"], form [aria-label*="Uploading" i], [data-testid*="attachment"] .animate-spin, form .animate-spin',
};
