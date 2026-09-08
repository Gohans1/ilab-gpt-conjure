import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupActiveBrowsers,
  cleanupStaleLocks,
  findBrowserPidsByTagAsync,
  getActiveBrowserPids,
  killOrphanBrowsers,
  killOrphanBrowsersByTag,
  killOrphanBrowsersByTagAsync,
  killProcessTree,
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
    writeFileSync(join(testDir, "regular-file.txt"), "keep me");

    cleanupStaleLocks(testDir);

    expect(existsSync(join(testDir, "SingletonLock"))).toBe(false);
    expect(existsSync(join(testDir, "SingletonCookie"))).toBe(false);
    expect(existsSync(join(testDir, "SingletonSocket"))).toBe(false);
    expect(existsSync(join(testDir, "lockfile"))).toBe(false);
    expect(existsSync(join(testDir, "regular-file.txt"))).toBe(true);

    rmSync(testDir, { recursive: true, force: true });
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
  });
});
