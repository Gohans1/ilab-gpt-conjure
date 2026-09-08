import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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
  browser?: "chrome" | "edge" | string;
}

const activeBrowserPids = new Set<number>();

const activeBrowsers = new Set<Browser>();

export function getActiveBrowserPids(): number[] {
  return Array.from(activeBrowserPids);
}

export function cleanupActiveBrowsers(): void {
  const hadUntracked = activeBrowsers.size > 0 && activeBrowserPids.size === 0;
  for (const pid of activeBrowserPids) {
    killProcessTree(pid);
  }
  activeBrowserPids.clear();
  if (activeBrowsers.size > 0) {
    for (const b of activeBrowsers) {
      b.close().catch(() => {});
    }
    activeBrowsers.clear();
    if (hadUntracked) {
      killOrphanBrowsers(undefined, true);
    }
  }
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
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  try {
    process.kill(pid, 0);
  } catch {
    return;
  }
  if (process.platform === "win32") {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const tasklist = join(systemRoot, "System32", "tasklist.exe");
      const check = spawnSync(tasklist, ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2000,
      });
      const line = (check.stdout || "").toLowerCase();
      if (!line.includes("chrome.exe") && !line.includes("msedge.exe") && !line.includes("chromium.exe")) {
        return;
      }
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
$pattern = if ('${normalized}') { [regex]::Escape('${normalized}') } else { '--chatgpt-bridge-instance' };
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe' or Name = 'chromium.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match $pattern) } |
  ForEach-Object {
    & "taskkill.exe" /PID $_.ProcessId /T /F 2>$null
    if ($LASTEXITCODE -ne 0) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
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
        const escaped = profileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        spawnSync("pkill", ["-f", escaped], { stdio: "ignore" });
      } else {
        spawnSync("pkill", ["-f", "--chatgpt-bridge-instance"], { stdio: "ignore" });
      }
    } catch {}
  }
  if (profileDir) {
    cleanupStaleLocks(profileDir);
  }
}

export async function findBrowserPidsByTagAsync(tag: string): Promise<number[]> {
  if (!tag || process.platform !== "win32") return [];
  return new Promise<number[]>((resolve) => {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const safeTag = tag.replace(/[/\\]+/g, "\\").replace(/'/g, "''");
      const script = `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe' or Name = 'chromium.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape('${safeTag}') } | Select-Object -ExpandProperty ProcessId`;
      const b64 = Buffer.from(script, "utf16le").toString("base64");
      const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      child.stdout?.on("data", (d) => {
        out += d.toString();
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve([]);
      }, 4000);
      child.on("close", () => {
        clearTimeout(timer);
        const pids = out
          .split(/\r?\n/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isInteger(n) && n > 0);
        resolve(pids);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve([]);
      });
    } catch {
      resolve([]);
    }
  });
}

export async function killOrphanBrowsersByTagAsync(tag: string): Promise<void> {
  if (!tag || !tag.startsWith("--chatgpt-bridge-instance")) return;
  if (process.platform === "win32") {
    return new Promise<void>((resolve) => {
      try {
        const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
        const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const safeTag = tag.replace(/[/\\]+/g, "\\").replace(/'/g, "''");
        const script = `
$escapedTag = [regex]::Escape('${safeTag}');
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe' or Name = 'chromium.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $escapedTag } |
  ForEach-Object {
    & "taskkill.exe" /PID $_.ProcessId /T /F 2>$null
    if ($LASTEXITCODE -ne 0) {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
`.trim();
        const b64 = Buffer.from(script, "utf16le").toString("base64");
        const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], {
          stdio: "ignore",
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve();
        }, 5000);
        child.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        resolve();
      }
    });
  } else {
    try {
      const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      spawn("pkill", ["-f", escaped], { stdio: "ignore" }).unref();
    } catch {}
  }
}

export function killOrphanBrowsersByTag(tag: string): void {
  killOrphanBrowsersByTagAsync(tag).catch(() => {});
}

export function closeBrowserGracefully(profileDir?: string, pid?: number): void {
  if (!profileDir && !pid) return;
  if (process.platform === "win32") {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const parts: string[] = [];
      if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
        parts.push(`Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }`);
      }
      if (profileDir && profileDir.trim()) {
        const normalized = profileDir.replace(/[/\\]+/g, "\\").replace(/'/g, "''");
        parts.push(`
$pattern = [regex]::Escape('${normalized}');
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe' or Name = 'chromium.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match $pattern) } |
  ForEach-Object {
    $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    if ($p) {
      try { $p.CloseMainWindow() | Out-Null } catch {}
    }
  }
`.trim());
      }
      if (parts.length === 0) return;
      const script = parts.join("\n");
      const b64 = Buffer.from(script, "utf16le").toString("base64");
      const proc = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], {
        stdio: "ignore",
        windowsHide: true,
      });
      proc.unref();
      const watchdog = setTimeout(() => {
        try {
          proc.kill();
        } catch {}
      }, 4000);
      if (typeof watchdog.unref === "function") {
        watchdog.unref();
      }
      proc.once("exit", () => clearTimeout(watchdog));
      proc.once("error", () => clearTimeout(watchdog));
    } catch {}
  } else if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

export function cleanupStaleLocks(profileDir: string): void {
  const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"];
  for (const name of locks) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch {}
  }
}

export function isBrowserProfileLockedByFs(profileDir: string): boolean {
  if (!profileDir || !existsSync(profileDir)) return false;
  if (process.platform === "win32") {
    const candidateFiles = ["lockfile", "SingletonLock"];
    for (const relPath of candidateFiles) {
      const lockPath = join(profileDir, relPath);
      if (existsSync(lockPath)) {
        try {
          const fd = openSync(lockPath, "r+");
          closeSync(fd);
        } catch (err: any) {
          if (err?.code === "EBUSY" || err?.code === "EPERM" || err?.code === "EACCES") {
            return true;
          }
        }
      }
    }
  }
  return false;
}

export async function isBrowserProfileInUseAsync(profileDir: string, altProfileDir?: string): Promise<boolean> {
  const hasPrimary = Boolean(profileDir && existsSync(profileDir));
  const hasAlt = Boolean(altProfileDir && existsSync(altProfileDir));
  if (!hasPrimary && !hasAlt) return false;

  // 1. Fast path: check file lock directly (0.01ms, 0% CPU, non-blocking)
  if (isBrowserProfileLockedByFs(profileDir) || (altProfileDir && isBrowserProfileLockedByFs(altProfileDir))) {
    return true;
  }

  // 2. Fallback: check running processes asynchronously so Bun event loop is NEVER blocked
  if (process.platform === "win32") {
    try {
      const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
      const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const checkDirs = Array.from(new Set([profileDir, altProfileDir].filter(Boolean) as string[]));
      const patterns = checkDirs.map((d) => d.replace(/[/\\]+/g, "\\").replace(/'/g, "''"));
      const script = `
$patterns = @(${patterns.map((p) => `'${p}'`).join(",")});
$found = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe' or Name = 'chromium.exe'" |
  Where-Object {
    if (!$_.CommandLine) { return $false }
    foreach ($p in $patterns) {
      if ($_.CommandLine -match [regex]::Escape($p)) { return $true }
    }
    return $false
  } |
  Select-Object -First 1
if ($found) { exit 0 } else { exit 1 }
`.trim();
      const b64 = Buffer.from(script, "utf16le").toString("base64");
      const proc = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", b64], {
        stdio: "ignore",
        windowsHide: true,
      });

      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          resolve(false);
        }, 3000);

        proc.once("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        proc.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      });
    } catch {
      return false;
    }
  } else {
    try {
      const checkDirs = [profileDir, altProfileDir].filter(Boolean) as string[];
      const escaped = checkDirs.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const proc = spawn("pgrep", ["-f", escaped], { stdio: "ignore" });
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {}
          resolve(false);
        }, 3000);
        proc.once("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        proc.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
      });
    } catch {
      return false;
    }
  }
}


export async function getBrowserSession(options: BrowserOptions = {}): Promise<BrowserSession> {
  const { primary, fallback, selectedBrowser, actualBrowser, fallbackUsed } = findBrowserCandidates(options.browser);
  let executablePath = primary[0] || fallback[0];
  if (!executablePath) {
    throw new Error(
      options.browser
        ? `Không tìm thấy trình duyệt ${options.browser.toUpperCase()} (và cả trình duyệt dự phòng) trên hệ thống. Vui lòng cài đặt Google Chrome hoặc Microsoft Edge.`
        : "Không tìm thấy Google Chrome hoặc Microsoft Edge trên hệ thống. Vui lòng cài đặt Google Chrome / Microsoft Edge hoặc chỉ định biến môi trường CHROME_PATH."
    );
  }

  if (fallbackUsed) {
    console.warn(
      `⚠️ [Browser Fallback] Trình duyệt '${selectedBrowser.toUpperCase()}' không khả dụng trên hệ thống. Tự động chuyển sang '${actualBrowser.toUpperCase()}' (${executablePath}).`
    );
  }

  // Mặc định luôn luôn hiển thị cửa sổ trình duyệt (headless: false) để chống Cloudflare Turnstile WAF chặn 500
  const headless = options.headless ?? false;
  const instanceTag = `--chatgpt-bridge-instance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Pre-flight cleanup: chỉ dọn dẹp nếu có PIDs mồ côi đã đăng ký mà không thuộc session active nào
  if (activeBrowsers.size === 0 && getActiveBrowserPids().length > 0) {
    cleanupActiveBrowsers();
  }

  const launchArgs = [
    instanceTag,
    "--chatgpt-bridge-instance",
    "--disable-blink-features=AutomationControlled",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=AutoDeElevate,ProfilePickerOnStartup",
    "--do-not-de-elevate",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-dev-shm-usage",
  ];
  const ignoreDefaultArgs = ["--password-store=basic", "--use-mock-keychain"];

  let browser: any;
  try {
    browser = await chromium.launch({
      executablePath,
      headless,
      ignoreDefaultArgs,
      args: launchArgs,
    });
  } catch (launchErr: any) {
    if (!fallbackUsed && fallback[0] && fallback[0] !== executablePath) {
      const fallbackTarget = actualBrowser === selectedBrowser ? (selectedBrowser === "edge" ? "chrome" : "edge") : actualBrowser;
      console.warn(
        `⚠️ [Browser Launch Retry] Khởi động trình duyệt '${selectedBrowser.toUpperCase()}' thất bại (${launchErr?.message || launchErr}). Đang thử fallback sang '${fallbackTarget.toUpperCase()}' (${fallback[0]})...`
      );
      executablePath = fallback[0];
      browser = await chromium.launch({
        executablePath,
        headless,
        ignoreDefaultArgs,
        args: launchArgs,
      });
    } else {
      throw launchErr;
    }
  }

  let isSessionClosed = false;
  let cleanupDone = false;
  const trackedPids = new Set<number>();

  const triggerCleanup = async () => {
    if (cleanupDone) return;
    cleanupDone = true;
    isSessionClosed = true;

    activeBrowsers.delete(browser);
    for (const pid of trackedPids) {
      killProcessTree(pid);
      unregisterActiveBrowserPid(pid);
    }
    await killOrphanBrowsersByTagAsync(instanceTag);
  };

  findBrowserPidsByTagAsync(instanceTag).then((pids) => {
    if (isSessionClosed || !browser.isConnected()) {
      // Session đã kết thúc hoặc browser đã ngắt kết nối trước khi tìm xong PID.
      // Diệt ngay lập tức các PID vừa tìm được để chống rò rỉ Zombie PID vào bộ nhớ.
      for (const pid of pids) {
        killProcessTree(pid);
      }
      return;
    }
    for (const pid of pids) {
      trackedPids.add(pid);
      registerActiveBrowserPid(pid);
    }
  }).catch(() => {});

  activeBrowsers.add(browser);
  browser.on("disconnected", () => {
    isSessionClosed = true;
    triggerCleanup().catch(() => {});
  });

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

    let closePromise: Promise<void> | null = null;

    return {
      browser,
      context,
      page,
      close: () =>
        (closePromise ??= (async () => {
          isSessionClosed = true;
          let timer: any;
          try {
            await Promise.race([
              (async () => {
                await context.close().catch(() => {});
                await browser.close().catch(() => {});
              })(),
              new Promise((resolve) => {
                timer = setTimeout(resolve, 3000);
              }),
            ]);
            if (timer) clearTimeout(timer);
          } catch {}

          await triggerCleanup();
        })()),
    };
  } catch (err) {
    await triggerCleanup();
    await browser.close().catch(() => {});
    throw err;
  }
}

// Global hook để đảm bảo dọn sạch các tiến trình browser con khi tiến trình chính kết thúc
process.on("exit", () => {
  cleanupActiveBrowsers();
});
