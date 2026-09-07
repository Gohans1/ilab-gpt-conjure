import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, STORAGE_STATE_PATH, USER_DATA_DIR } from "./config.js";

export function getSessionVerifiedMarkerPath(): string {
  return join(USER_DATA_DIR, ".session-verified");
}

export function markSessionVerified(): void {
  try {
    atomicWriteFile(getSessionVerifiedMarkerPath(), new Date().toISOString());
  } catch {
    try {
      writeFileSync(getSessionVerifiedMarkerPath(), new Date().toISOString(), "utf-8");
    } catch {}
  }
}

export function clearSessionVerified(deleteStorage: boolean = false): void {
  try {
    rmSync(getSessionVerifiedMarkerPath(), { force: true });
  } catch {}
  if (deleteStorage) {
    try {
      rmSync(STORAGE_STATE_PATH, { force: true });
    } catch {}
  }
}

export function isSessionCookieValid(cookie: {
  name: string;
  value?: string;
  expires?: number;
  domain?: string;
}): boolean {
  const isTargetName =
    cookie.name === "__Secure-next-auth.session-token" ||
    cookie.name.startsWith("__Secure-next-auth.session-token.") ||
    cookie.name === "next-auth.session-token" ||
    cookie.name.startsWith("next-auth.session-token.") ||
    cookie.name === "__Secure-authjs.session-token" ||
    cookie.name.startsWith("__Secure-authjs.session-token.") ||
    cookie.name === "authjs.session-token" ||
    cookie.name.startsWith("authjs.session-token.");

  if (!isTargetName) return false;
  if (!cookie.value || typeof cookie.value !== "string" || cookie.value.length < 20 || cookie.value === "deleted") return false;
  const d = cookie.domain ? cookie.domain.replace(/^\./, "").toLowerCase() : "";
  if (d && d !== "chatgpt.com" && !d.endsWith(".chatgpt.com") && d !== "openai.com" && !d.endsWith(".openai.com")) return false;
  if (typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires <= Date.now() / 1000) return false;
  return true;
}

export function isSessionCached(): boolean {
  // Cả storage-state.json và marker .session-verified đều phải tồn tại và hợp lệ
  // (Kiến trúc tương đồng browserLoginStateExists của codex-chatgpt-web)
  if (!existsSync(STORAGE_STATE_PATH)) {
    clearSessionVerified(false);
    return false;
  }

  const markerPath = getSessionVerifiedMarkerPath();
  if (!existsSync(markerPath)) {
    return false;
  }

  try {
    const markerContent = readFileSync(markerPath, "utf-8").trim();
    const markerTime = Date.parse(markerContent);
    // Marker quá 14 ngày hoặc lệch tương lai quá 5 phút thì coi như hết hạn
    if (Number.isNaN(markerTime) || markerTime > Date.now() + 300_000 || Date.now() - markerTime > 14 * 24 * 60 * 60 * 1000) {
      clearSessionVerified(false);
      return false;
    }

    const raw = readFileSync(STORAGE_STATE_PATH, "utf-8");
    const data = JSON.parse(raw);
    const cookies = Array.isArray(data?.cookies) ? data.cookies : [];
    // Chống false-positive với chunked cookie (.0, .1): nếu bất kỳ chunk nào hết hạn, coi như phiên đã hết hạn
    const sessionTokenCookies = cookies.filter((c: any) =>
      c?.name && (
        c.name === "__Secure-next-auth.session-token" ||
        c.name.startsWith("__Secure-next-auth.session-token.") ||
        c.name === "next-auth.session-token" ||
        c.name.startsWith("next-auth.session-token.") ||
        c.name === "__Secure-authjs.session-token" ||
        c.name.startsWith("__Secure-authjs.session-token.") ||
        c.name === "authjs.session-token" ||
        c.name.startsWith("authjs.session-token.")
      )
    );
    const anyChunkExpired = sessionTokenCookies.some((c: any) =>
      typeof c.expires === "number" && c.expires > 0 && c.expires <= Date.now() / 1000
    );
    if (anyChunkExpired) {
      clearSessionVerified(false);
      return false;
    }

    const hasValidToken = cookies.some(isSessionCookieValid);
    if (hasValidToken) {
      return true;
    }
    // Token không hợp lệ hoặc đã hết hạn -> Gỡ marker, bảo toàn file đĩa
    clearSessionVerified(false);
    return false;
  } catch {
    clearSessionVerified(false);
    return false;
  }
}

if (import.meta.main) {
  const ok = isSessionCached();
  if (ok) {
    console.log("[Session] Da phat hien session ChatGPT hop le.");
    process.exit(0);
  } else {
    console.log("[Session] Chua co session ChatGPT.");
    process.exit(1);
  }
}
