import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupActiveBrowsers,
  cleanupStaleLocks,
  closeBrowserGracefully,
  findBrowserPidsByTagAsync,
  getActiveBrowserPids,
  isBrowserProfileInUseAsync,
  isBrowserProfileLockedByFs,
  killOrphanBrowsers,
  killOrphanBrowsersAsync,
  killOrphanBrowsersByTag,
  killOrphanBrowsersByTagAsync,
  killProcessTree,
  parseDevToolsActivePort,
  registerActiveBrowserPid,
  unregisterActiveBrowserPid,
} from "./browser.js";
import { findBrowserCandidates, normalizeBrowserChoice } from "./config.js";

describe("browser helpers", () => {
  test("normalizeBrowserChoice chuẩn hóa đúng các biến thể Edge, Chrome, Brave, Opera, Canary", () => {
    expect(normalizeBrowserChoice("msedge")).toBe("edge");
    expect(normalizeBrowserChoice("MicrosoftEdge.exe")).toBe("edge");
    expect(normalizeBrowserChoice("edge-canary.exe")).toBe("edge");
    expect(normalizeBrowserChoice("chrome")).toBe("chrome");
    expect(normalizeBrowserChoice("Google Chrome.exe")).toBe("chrome");
    expect(normalizeBrowserChoice("chromium-browser")).toBe("chrome");
    expect(normalizeBrowserChoice("brave.exe")).toBe("chrome");
    expect(normalizeBrowserChoice("opera.exe")).toBe("chrome");
    expect(normalizeBrowserChoice("unknown-browser")).toBeUndefined();
  });

  test("cleanupStaleLocks xóa đúng các file lock rác mà không gây crash", () => {
    const testDir = join(tmpdir(), "test-locks-" + Date.now());
    mkdirSync(testDir, { recursive: true });

    writeFileSync(join(testDir, "SingletonLock"), "lock");
    writeFileSync(join(testDir, "SingletonCookie"), "cookie");
    writeFileSync(join(testDir, "SingletonSocket"), "socket");
    writeFileSync(join(testDir, "lockfile"), "lockfile");
    writeFileSync(join(testDir, "DevToolsActivePort"), "12345\n/devtools/browser/abc");
    writeFileSync(join(testDir, "regular-file.txt"), "keep me");

    cleanupStaleLocks(testDir);

    expect(existsSync(join(testDir, "SingletonLock"))).toBe(false);
    expect(existsSync(join(testDir, "SingletonCookie"))).toBe(false);
    expect(existsSync(join(testDir, "SingletonSocket"))).toBe(false);
    expect(existsSync(join(testDir, "lockfile"))).toBe(false);
    expect(existsSync(join(testDir, "DevToolsActivePort"))).toBe(false);
    expect(existsSync(join(testDir, "regular-file.txt"))).toBe(true);

    rmSync(testDir, { recursive: true, force: true });
  });

  test("isBrowserProfileLockedByFs phát hiện đúng trạng thái lock file", () => {
    const testDir = join(tmpdir(), "test-locked-fs-" + Date.now());
    try {
      mkdirSync(join(testDir, "Default", "Network"), { recursive: true });

      // Khi chưa có file hoặc file không bị lock -> false
      expect(isBrowserProfileLockedByFs(testDir)).toBe(false);

      // Khi file có mặt và mở được bình thường -> false
      const cookiesPath = join(testDir, "Default", "Network", "Cookies");
      writeFileSync(cookiesPath, "dummy-sqlite-data");
      expect(isBrowserProfileLockedByFs(testDir)).toBe(false);

      // Khi file bị khóa quyền ghi (read-only) -> isBrowserProfileLockedByFs phát hiện ra lock (true trên Windows)
      if (process.platform === "win32") {
        chmodSync(cookiesPath, 0o444);
        expect(isBrowserProfileLockedByFs(testDir)).toBe(true);

        // Khi khôi phục quyền ghi -> false
        chmodSync(cookiesPath, 0o666);
        expect(isBrowserProfileLockedByFs(testDir)).toBe(false);
      } else {
        const lockFile = join(testDir, "SingletonLock");
        writeFileSync(lockFile, "dummy");
        expect(isBrowserProfileLockedByFs(testDir)).toBe(true);
        rmSync(lockFile, { force: true });
        expect(isBrowserProfileLockedByFs(testDir)).toBe(false);
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("isBrowserProfileInUseAsync kiểm tra chính xác trạng thái thư mục profile", async () => {
    const testDir = join(tmpdir(), "test-in-use-fs-" + Date.now());
    try {
      expect(await isBrowserProfileInUseAsync(testDir)).toBe(false);

      mkdirSync(join(testDir, "Default", "Network"), { recursive: true });
      const cookiesPath = join(testDir, "Default", "Network", "Cookies");
      writeFileSync(cookiesPath, "dummy-sqlite-data");

      if (process.platform === "win32") {
        chmodSync(cookiesPath, 0o444);
        expect(await isBrowserProfileInUseAsync(testDir)).toBe(true);
        chmodSync(cookiesPath, 0o666);
        expect(await isBrowserProfileInUseAsync(testDir)).toBe(false);
      } else {
        const lockFile = join(testDir, "SingletonLock");
        writeFileSync(lockFile, "dummy");
        expect(await isBrowserProfileInUseAsync(testDir)).toBe(true);
        rmSync(lockFile, { force: true });
        expect(await isBrowserProfileInUseAsync(testDir)).toBe(false);
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("findBrowserCandidates trả về cấu trúc primary và fallback", () => {
    const candidates = findBrowserCandidates();
    expect(Array.isArray(candidates.primary)).toBe(true);
    expect(Array.isArray(candidates.fallback)).toBe(true);
  });

  test("findBrowserCandidates phân tích đúng cả khi truyền đường dẫn exe đầy đủ", () => {
    const chromeFullPath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const edgeFullPath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

    const chromeRes = findBrowserCandidates(chromeFullPath);
    expect(chromeRes.selectedBrowser).toBe("chrome");

    const edgeRes = findBrowserCandidates(edgeFullPath);
    expect(edgeRes.selectedBrowser).toBe("edge");
  });

  test("killOrphanBrowsers thực thi an toàn mà không throw lỗi kể cả khi force = true", () => {
    expect(() => killOrphanBrowsers("non-existent-profile-path")).not.toThrow();
    expect(() => killOrphanBrowsers("non-existent-profile-path", true)).not.toThrow();
    expect(() => killOrphanBrowsers()).not.toThrow();
  }, 15000);

  test("getActiveBrowserPids và cleanupActiveBrowsers hoạt động ổn định", () => {
    expect(Array.isArray(getActiveBrowserPids())).toBe(true);
    expect(() => cleanupActiveBrowsers()).not.toThrow();
    expect(getActiveBrowserPids()).toEqual([]);
  });

  test("killProcessTree thực thi an toàn với PID không tồn tại hoặc không hợp lệ", () => {
    expect(() => killProcessTree(99999999)).not.toThrow();
    expect(() => killProcessTree(0)).not.toThrow();
    expect(() => killProcessTree(-1)).not.toThrow();
    expect(() => killProcessTree(NaN as any)).not.toThrow();
    expect(() => killProcessTree(3.14)).not.toThrow();

    registerActiveBrowserPid(99999998);
    expect(() => killProcessTree(99999998)).not.toThrow();
    unregisterActiveBrowserPid(99999998);
  });

  test("killProcessTree sử dụng fast-path trực tiếp khi PID nằm trong activeBrowserPids", () => {
    const dummy = spawn(
      process.platform === "win32" ? "ping" : "sleep",
      process.platform === "win32" ? ["127.0.0.1", "-n", "10"] : ["10"],
      { stdio: "ignore" }
    );
    const pid = dummy.pid;
    expect(pid).toBeDefined();
    if (pid) {
      registerActiveBrowserPid(pid);
      try {
        expect(getActiveBrowserPids().includes(pid)).toBe(true);
        expect(() => killProcessTree(pid)).not.toThrow();
        let dead = false;
        for (let i = 0; i < 15; i++) {
          try {
            process.kill(pid, 0);
            Bun.sleepSync(20);
          } catch {
            dead = true;
            break;
          }
        }
        expect(dead).toBe(true);
      } finally {
        unregisterActiveBrowserPid(pid);
        try {
          dummy.kill("SIGKILL");
        } catch {}
      }
    }
  });

  test("killProcessTree hỗ trợ cờ isKnownBrowser bỏ qua tasklist.exe", () => {
    const dummy = spawn(
      process.platform === "win32" ? "ping" : "sleep",
      process.platform === "win32" ? ["127.0.0.1", "-n", "10"] : ["10"],
      { stdio: "ignore" }
    );
    const pid = dummy.pid;
    expect(pid).toBeDefined();
    if (pid) {
      try {
        expect(() => killProcessTree(pid, true)).not.toThrow();
      } finally {
        try {
          dummy.kill("SIGKILL");
        } catch {}
      }
    }
  });

  test("browser process handling an toàn khi đối tượng browser không có method process", () => {
    const mockBrowser: any = { close: async () => {} };
    const pid = mockBrowser.process?.()?.pid;
    expect(pid).toBeUndefined();
  });

  test("findBrowserPidsByTagAsync và killOrphanBrowsersByTagAsync hoạt động an toàn với tag giả lập", async () => {
    const fakeTag = "--chatgpt-bridge-instance-fake-test-123456";
    const pids = await findBrowserPidsByTagAsync(fakeTag);
    expect(Array.isArray(pids)).toBe(true);
    expect(pids.length).toBe(0);

    await expect(killOrphanBrowsersByTagAsync(fakeTag)).resolves.toBeUndefined();

    expect(() => {
      killOrphanBrowsersByTag(fakeTag);
    }).not.toThrow();
  }, 15000);

  test("killOrphanBrowsersAsync thực thi an toàn mà không throw lỗi kể cả với mảng profile dirs", async () => {
    await expect(killOrphanBrowsersAsync("non-existent-profile-path")).resolves.toBeUndefined();
    await expect(killOrphanBrowsersAsync(["non-existent-1", "non-existent-2"], true)).resolves.toBeUndefined();
    await expect(killOrphanBrowsersAsync()).resolves.toBeUndefined();
  }, 15000);

  test("closeBrowserGracefully thực thi an toàn với cả mảng profile dirs và PID không hợp lệ", () => {
    expect(() => closeBrowserGracefully("non-existent-profile-path")).not.toThrow();
    expect(() => closeBrowserGracefully(["non-existent-1", "non-existent-2"], 99999999)).not.toThrow();
    expect(() => closeBrowserGracefully(undefined, undefined)).not.toThrow();
  });

  test("parseDevToolsActivePort phân tích chính xác các định dạng port và wsPath", () => {
    // 1. Chuẩn CRLF từ Chrome/Edge Windows với wsPath
    expect(parseDevToolsActivePort("9222\r\n/devtools/browser/abc-123\r\n")).toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
    // 2. Chuẩn LF
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc-123\n")).toBe("ws://127.0.0.1:9222/devtools/browser/abc-123");
    // 3. wsPath không có leading slash
    expect(parseDevToolsActivePort("54321\ndevtools/browser/xyz\n")).toBe("ws://127.0.0.1:54321/devtools/browser/xyz");
    // 4. Chỉ có port, không có wsPath: trả về null nếu allowHttpFallback = false
    expect(parseDevToolsActivePort("9222\n")).toBeNull();
    // 5. Chỉ có port, allowHttpFallback = true: fallback sang http://
    expect(parseDevToolsActivePort("9222\n", true)).toBe("http://127.0.0.1:9222");
    // 6. Port không hợp lệ: 0, 65536, âm, chữ, rỗng
    expect(parseDevToolsActivePort("0\n/devtools")).toBeNull();
    expect(parseDevToolsActivePort("65536\n/devtools")).toBeNull();
    expect(parseDevToolsActivePort("-1\n/devtools")).toBeNull();
    expect(parseDevToolsActivePort("abc\n/devtools")).toBeNull();
    expect(parseDevToolsActivePort("")).toBeNull();
    expect(parseDevToolsActivePort(null as any)).toBeNull();
  });
});
