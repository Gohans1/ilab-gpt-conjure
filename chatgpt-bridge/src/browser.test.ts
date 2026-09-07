import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupStaleLocks, getFreePort } from "./browser.js";
import { findBrowserCandidates } from "./config.js";

describe("browser helpers", () => {
  test("cleanupStaleLocks xóa đúng các file lock rác mà không gây crash", () => {
    const testDir = join(tmpdir(), "test-locks-" + Date.now());
    mkdirSync(testDir, { recursive: true });

    writeFileSync(join(testDir, "SingletonLock"), "lock");
    writeFileSync(join(testDir, "SingletonCookie"), "cookie");
    writeFileSync(join(testDir, "SingletonSocket"), "socket");
    writeFileSync(join(testDir, "regular-file.txt"), "keep me");

    cleanupStaleLocks(testDir);

    expect(existsSync(join(testDir, "SingletonLock"))).toBe(false);
    expect(existsSync(join(testDir, "SingletonCookie"))).toBe(false);
    expect(existsSync(join(testDir, "SingletonSocket"))).toBe(false);
    expect(existsSync(join(testDir, "regular-file.txt"))).toBe(true);

    rmSync(testDir, { recursive: true, force: true });
  });

  test("getFreePort trả về port hợp lệ", async () => {
    const port = await getFreePort();
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  test("findBrowserCandidates trả về cấu trúc primary và fallback", () => {
    const candidates = findBrowserCandidates();
    expect(Array.isArray(candidates.primary)).toBe(true);
    expect(Array.isArray(candidates.fallback)).toBe(true);
  });
});
