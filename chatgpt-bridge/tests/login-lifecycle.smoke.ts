// Run explicitly: bun run tests/login-lifecycle.smoke.ts edge done
// Uses a fresh profile and LOCAL fixture cookies. Never logs in to ChatGPT.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";

const browser = process.argv[2] || "edge";
const completion = process.argv[3] || "done";
assert(["edge", "chrome"].includes(browser));
assert(["done", "close"].includes(completion));
const root = mkdtempSync(join(tmpdir(), "login-lifecycle-"));
process.env.CHATGPT_PROFILE_DIR = join(root, "profile");
let ready!: () => void;
const visited = new Promise<void>((resolve) => { ready = resolve; });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (new URL(request.url).pathname === "/ready") {
    assert(request.headers.get("cookie")?.includes("session_probe=local-fixture"));
    ready();
    return new Response("ready");
  }
  const headers = new Headers({ "Content-Type": "text/html" });
  headers.append("Set-Cookie", "session_probe=local-fixture; Path=/; HttpOnly");
  headers.append("Set-Cookie", "persistent_probe=local-fixture; Path=/; HttpOnly; Max-Age=3600");
  return new Response('<!doctype html><title>Local login test</title>Local fixture only.<script>fetch("/ready")</script>', { headers });
} });
const config = await import("../src/config.js");
assert(config.findBrowserCandidates(browser).primary.length > 0, `${browser} is not installed`);
mock.module("../src/config.js", () => ({
  ...config,
  CHATGPT_LOGIN_URL: server.url.href,
  CHATGPT_TEMPORARY_CHAT_URL: server.url.href,
}));
const session = await import("../src/check-session.js");
const allowedHost = session.allowedLoginStorageHost;
// Substitute ONLY the authentication boundary: localhost fixtures are not ChatGPT credentials.
mock.module("../src/check-session.js", () => ({
  ...session,
  allowedLoginStorageHost: (host: string) => host === "127.0.0.1" || allowedHost(host),
  hasValidSessionToken: (cookies: any[]) =>
    cookies.some(
      (c) =>
        (c.domain === "127.0.0.1" || c.domain === "localhost") &&
        (c.name === "session_probe" || c.name === "persistent_probe") &&
        c.value === "local-fixture"
    ),
}));
const { handleLogin, notifyLoginContinuation } = await import("../src/auth-helper.js");
const { closeBrowserGracefully, killOrphanBrowsers, getActiveBrowserPids } = await import("../src/browser.js");
let watchdog: ReturnType<typeof setTimeout>;
const login = handleLogin(30_000, browser);
// Attach rejection handling immediately, including when the local page never opens.
const result = login.then(() => null, error => error);
try {
  await Promise.race([
    visited,
    result.then(error => { throw error || new Error("Login ended before the fixture loaded"); }),
    new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("Local login window did not load")), 25_000); }),
  ]);
  await Bun.sleep(2500);
  if (completion === "done") {
    assert(notifyLoginContinuation(), "Completion notification was not accepted");
  } else {
    const profileEntries = readdirSync(join(root, "login-profiles")).map(p => join(root, "login-profiles", p));
    const pids = getActiveBrowserPids();
    closeBrowserGracefully(profileEntries, pids[pids.length - 1]);
  }
  const error = await result;
  if (error) throw error;
  const saved = JSON.parse(readFileSync(config.STORAGE_STATE_PATH, "utf8"));
  assert(saved.cookies.some((c: any) => c.name === "persistent_probe" || c.name === "session_probe"), "Authentication cookie was lost");
  assert(existsSync(session.getSessionVerifiedMarkerPath()), "Successful capture did not set its marker");
  assert.deepEqual(readdirSync(join(root, "login-profiles")), [], "Login profile was not cleaned up");
  assert.deepEqual(getActiveBrowserPids(), [], "Login PID was not released");
  console.log(`PASS: ${browser}/${completion}: local session and persistent cookies saved; marker set; profile cleaned`);
} finally {
  clearTimeout(watchdog!);
  server.stop(true);
  if (existsSync(join(root, "login-profiles"))) {
    for (const name of readdirSync(join(root, "login-profiles"))) {
      killOrphanBrowsers(join(root, "login-profiles", name), true);
    }
  }
  await result;
  rmSync(root, { recursive: true, force: true });
}
