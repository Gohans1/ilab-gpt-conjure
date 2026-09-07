import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { findBrowserCandidates, USER_DATA_DIR } from "./config.js";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export interface BrowserOptions {
  headless?: boolean;
}

export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
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

export function killOrphanBrowsers(profileDir: string): void {
  if (process.platform === "win32") {
    try {
      const normalized = profileDir.replace(/[/\\]+/g, "\\").replace(/'/g, "''");
      const script = `
$target = [regex]::Escape('${normalized}');
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' or Name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -and ($_.CommandLine -match $target -or $_.CommandLine -match 'chatgpt-profile') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`.trim();
      const b64 = Buffer.from(script, "utf16le").toString("base64");
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch {}
  } else {
    try {
      spawnSync("pkill", ["-f", profileDir], { stdio: "ignore" });
    } catch {}
  }
}

export function cleanupStaleLocks(profileDir: string): void {
  const locks = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  for (const name of locks) {
    const lockFile = join(profileDir, name);
    if (existsSync(lockFile)) {
      try {
        unlinkSync(lockFile);
      } catch {
        // Ignored if actively held by a running process
      }
    }
  }
}

export function getFreePort(preferred = 9222): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(preferred, "127.0.0.1", () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", () => {
      const altSrv = createServer();
      altSrv.listen(0, "127.0.0.1", () => {
        const port = (altSrv.address() as any).port;
        altSrv.close(() => resolve(port));
      });
      altSrv.on("error", () => resolve(9222));
    });
  });
}

async function waitForCDPEndpoint(
  port: number,
  isProcessAlive: () => boolean,
  timeoutMs = 7000
): Promise<boolean> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive()) return false;
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function spawnBrowserProcess(
  executablePath: string,
  port: number,
  profileDir: string,
  headless: boolean
): ChildProcess {
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--window-size=1280,900",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  if (headless) {
    args.push("--headless=new");
  }
  args.push("about:blank");

  return spawn(executablePath, args, {
    detached: false,
    stdio: "ignore",
  });
}

export async function getBrowserSession(options: BrowserOptions = {}): Promise<BrowserSession> {
  if (!existsSync(USER_DATA_DIR)) {
    mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const headless = options.headless ?? false;
  const { primary, fallback } = findBrowserCandidates();

  const candidates = [
    ...primary.map((path) => ({ type: "Google Chrome", path })),
    ...fallback.map((path) => ({ type: "Microsoft Edge (Fallback)", path })),
  ];

  if (candidates.length === 0) {
    throw new Error(
      "Không tìm thấy Google Chrome hoặc Microsoft Edge trên máy. Vui lòng cài đặt Chrome hoặc Edge!"
    );
  }

  cleanupStaleLocks(USER_DATA_DIR);

  let activeProc: ChildProcess | null = null;
  let connectedBrowser: any = null;

  for (const candidate of candidates) {
    killOrphanBrowsers(USER_DATA_DIR);
    cleanupStaleLocks(USER_DATA_DIR);
    const port = await getFreePort();
    console.log(`[Browser] Khởi chạy ${candidate.type} (headless: ${headless}, port: ${port}) tại: ${USER_DATA_DIR}`);

    const proc = spawnBrowserProcess(candidate.path, port, USER_DATA_DIR, headless);

    const isReady = await waitForCDPEndpoint(port, () => proc.exitCode === null, 7000);
    if (!isReady || proc.exitCode !== null) {
      console.warn(`⚠️ [Browser] ${candidate.type} không phản hồi CDP hoặc tự thoát (exitCode: ${proc.exitCode}). Thử phương án tiếp theo...`);
      if (proc.pid) killProcessTree(proc.pid);
      killOrphanBrowsers(USER_DATA_DIR);
      cleanupStaleLocks(USER_DATA_DIR);
      continue;
    }

    try {
      connectedBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
      activeProc = proc;
      break;
    } catch (err) {
      console.warn(`⚠️ [Browser] Lỗi kết nối CDP tới ${candidate.type}:`, err);
      if (proc.pid) killProcessTree(proc.pid);
      killOrphanBrowsers(USER_DATA_DIR);
      cleanupStaleLocks(USER_DATA_DIR);
    }
  }

  if (!connectedBrowser || !activeProc) {
    throw new Error(
      "Không thể khởi chạy và kết nối tới trình duyệt qua cổng DevTools (đã thử cả Chrome và Edge fallback)."
    );
  }

  const contexts = connectedBrowser.contexts();
  const context = contexts[0] || (await connectedBrowser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  }));

  // Ẩn navigator.webdriver để tránh Cloudflare chặn
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  const page = context.pages()[0] || (await context.newPage());

  return {
    context,
    page,
    close: async () => {
      try {
        await connectedBrowser.close();
      } catch (err) {
        console.warn("⚠️ Không thể ngắt kết nối CDP hoàn tất:", err);
      }
      if (activeProc && activeProc.pid) {
        killProcessTree(activeProc.pid);
        await new Promise((r) => setTimeout(r, 200));
      }
      cleanupStaleLocks(USER_DATA_DIR);
    },
  };
}
