import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { findBrowserCandidates, STORAGE_STATE_PATH } from "./config.js";

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export interface BrowserOptions {
  headless?: boolean;
}

const activeBrowserPids = new Set<number>();

export function getActiveBrowserPids(): number[] {
  return Array.from(activeBrowserPids);
}

export function cleanupActiveBrowsers(): void {
  for (const pid of activeBrowserPids) {
    killProcessTree(pid);
  }
  activeBrowserPids.clear();
}

export function registerActiveBrowserPid(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) {
    activeBrowserPids.add(pid);
  }
}

export function unregisterActiveBrowserPid(pid: number): void {
  activeBrowserPids.delete(pid);
}

export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const taskkill = join(systemRoot, "System32", "taskkill.exe");
      spawnSync(taskkill, ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 3000,
      });
    } catch {}
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

export function killOrphanBrowsers(profileDir?: string, force = false): void {
  const hasLock = profileDir
    ? ["SingletonLock", "lockfile", "SingletonCookie", "SingletonSocket"].some((f) =>
        existsSync(join(profileDir, f))
      )
    : false;
  if (profileDir && !hasLock && !force) return;

  if (process.platform === "win32") {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const normalized = profileDir ? profileDir.replace(/[/\\]+/g, "\\").replace(/'/g, "''") : "";
      const script = `
$target = if ('${normalized}') { [regex]::Escape('${normalized}') } else { $null };
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
  Where-Object {
    $_.CommandLine -and (
      ($target -and $_.CommandLine -match $target) -or
      ($_.CommandLine -match '--chatgpt-bridge-instance')
    )
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`.trim();
      const b64 = Buffer.from(script, "utf16le").toString("base64");
      spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5000,
      });
    } catch {}
  } else {
    try {
      if (profileDir) {
        spawnSync("pkill", ["-f", profileDir], { stdio: "ignore" });
      } else {
        spawnSync("pkill", ["-f", "--chatgpt-bridge-instance"], { stdio: "ignore" });
      }
    } catch {}
  }
  if (profileDir) {
    cleanupStaleLocks(profileDir);
  }
}

export function cleanupStaleLocks(profileDir: string): void {
  const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];
  for (const name of locks) {
    const lockFile = join(profileDir, name);
    if (existsSync(lockFile)) {
      try {
        unlinkSync(lockFile);
      } catch {}
    }
  }
}


export async function getBrowserSession(options: BrowserOptions = {}): Promise<BrowserSession> {
  const { primary, fallback } = findBrowserCandidates();
  const executablePath = primary[0] || fallback[0];

  const headless = options.headless ?? true;

  const browser = await chromium.launch({
    executablePath: executablePath || undefined,
    headless,
    ignoreDefaultArgs: ["--enable-automation", "--password-store=basic", "--use-mock-keychain"],
    args: [
      "--chatgpt-bridge-instance",
      "--disable-blink-features=AutomationControlled",
      "--disable-background-mode",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const pid = (browser as any).process?.()?.pid;
  if (pid) {
    activeBrowserPids.add(pid);
  }

  try {
    let validStorageState: string | undefined = undefined;
    if (existsSync(STORAGE_STATE_PATH)) {
      try {
        const content = readFileSync(STORAGE_STATE_PATH, "utf-8").trim();
        if (content.length > 0) {
          JSON.parse(content);
          validStorageState = STORAGE_STATE_PATH;
        }
      } catch {
        console.warn("⚠️ [Browser] storage-state.json bị hỏng hoặc rỗng, khởi tạo context sạch không nạp cookie lỗi.");
      }
    }

    const context = await browser.newContext({
      storageState: validStorageState,
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    return {
      browser,
      context,
      page,
      close: async () => {
        let timer: any;
        let timedOut = false;
        await Promise.race([
          (async () => {
            await context.close().catch(() => {});
            await browser.close().catch(() => {});
          })(),
          new Promise((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              resolve(null);
            }, 5000);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (pid) {
          activeBrowserPids.delete(pid);
          if (timedOut) {
            killProcessTree(pid);
          }
        }
      },
    };
  } catch (err) {
    let timer: any;
    let timedOut = false;
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, 3000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (pid) {
      activeBrowserPids.delete(pid);
      if (timedOut) {
        killProcessTree(pid);
      }
    }
    throw err;
  }
}

// Global hook để đảm bảo dọn sạch các tiến trình browser đang chạy khi tiến trình chính kết thúc
process.on("exit", () => {
  cleanupActiveBrowsers();
});

export const createBrowserSession = getBrowserSession;
