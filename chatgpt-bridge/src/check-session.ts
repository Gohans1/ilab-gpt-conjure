import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { USER_DATA_DIR } from "./config.js";

export function isSessionCached(): boolean {
  // Check 1: Marker file from successful login
  const markerPath = join(USER_DATA_DIR, ".session-verified");
  if (existsSync(markerPath)) {
    return true;
  }

  // Check 2: Inspect Chromium SQLite cookies database for ChatGPT session tokens
  const cookiePath = join(USER_DATA_DIR, "Default", "Network", "Cookies");
  if (!existsSync(cookiePath)) {
    return false;
  }

  try {
    const db = new Database(cookiePath, { readonly: true });
    try {
      const row = db
        .query(
          "SELECT count(*) as count FROM cookies WHERE (host_key LIKE '%chatgpt.com%' OR host_key LIKE '%openai.com%') AND name LIKE '%session%'"
        )
        .get() as { count: number } | null;
      return (row?.count ?? 0) > 0;
    } finally {
      db.close();
    }
  } catch {
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
