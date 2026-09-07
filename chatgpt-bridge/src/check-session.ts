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

export const AUTH_PROVIDER_HOSTS = new Set([
  "chatgpt.com",
  "openai.com",
  "auth.openai.com",
  "auth0.openai.com",
  "login.openai.com",
  "accounts.openai.com",
  "accounts.google.com",
  "login.microsoftonline.com",
  "appleid.apple.com",
  "idmsa.apple.com",
]);

export function allowedLoginStorageHost(rawHostname: string): boolean {
  const hostname = (rawHostname || "").toLowerCase();
  if (
    !/^[a-z0-9.-]+$/.test(hostname) ||
    hostname.startsWith(".") ||
    hostname.endsWith(".") ||
    hostname.includes("..")
  ) {
    return false;
  }
  try {
    const parsed = new URL(`https://${hostname}/`);
    if (
      parsed.hostname !== hostname ||
      parsed.host !== hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
  } catch {
    return false;
  }
  return (
    hostname === "chatgpt.com" ||
    hostname.endsWith(".chatgpt.com") ||
    hostname === "openai.com" ||
    hostname.endsWith(".openai.com")
  );
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
  const d = cookie.domain ? cookie.domain.replace(/^\.+/, "").toLowerCase() : "";
  if (d && !allowedLoginStorageHost(d)) return false;
  if (typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires <= Date.now() / 1000) return false;
  return true;
}

export function hasValidSessionToken(cookies: any[]): boolean {
  if (!Array.isArray(cookies) || cookies.length === 0) return false;

  const baseNames = [
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
    "__Secure-authjs.session-token",
    "authjs.session-token",
  ];

  for (const base of baseNames) {
    // 1. Kiểm tra cookie đơn không chunk
    const singleCookie = cookies.find((c: any) => c?.name === base);
    if (singleCookie && isSessionCookieValid(singleCookie)) {
      return true;
    }

    // 2. Kiểm tra dạng chunked (.0, .1, ...)
    // Yêu cầu bắt buộc: chunk .0 phải tồn tại và hợp lệ
    const chunk0 = cookies.find((c: any) => c?.name === `${base}.0`);
    if (chunk0 && isSessionCookieValid(chunk0)) {
      const chunkRegex = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+$`);
      const allChunks = cookies.filter((c: any) => typeof c?.name === "string" && chunkRegex.test(c.name));
      // NextAuth khi phân mảnh cookie luôn tạo ít nhất 2 chunks (.0 và .1)
      if (allChunks.length >= 2) {
        const anyChunkInvalid = allChunks.some((c: any) => {
          if (!c.value || c.value === "deleted" || c.value.length < 10) return true;
          if (typeof c.expires === "number" && c.expires > 0 && c.expires <= Date.now() / 1000) return true;
          const d = c.domain ? c.domain.replace(/^\.+/, "").toLowerCase() : "";
          if (d && !allowedLoginStorageHost(d)) return true;
          return false;
        });

        if (!anyChunkInvalid) {
          return true;
        }
      }
    }
  }

  return false;
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
    const cookies: any[] = Array.isArray(data?.cookies) ? data.cookies : [];

    if (hasValidSessionToken(cookies)) {
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
