import { getBrowserSession } from "./browser.js";
import { CHATGPT_URL } from "./config.js";
import { checkIsLoggedIn } from "./auth-helper.js";
import { isSessionCached } from "./check-session.js";

async function runTest() {
  console.log("🔍 Đang kiểm tra kết nối trình duyệt và trạng thái đăng nhập ChatGPT...");

  const cached = isSessionCached();
  if (!cached) {
    console.log("ℹ️ [Session] Chưa phát hiện session hợp lệ trên đĩa (storage-state.json).");
  } else {
    console.log("🔑 [Session] Đã phát hiện session token hợp lệ trên đĩa.");
  }

  const session = await getBrowserSession({ headless: true });
  let hasError = false;

  try {
    console.log(`✅ Đã khởi chạy Chrome thành công!`);
    console.log(`🌐 Đang mở trang: ${CHATGPT_URL}...`);
    await session.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const loggedIn = await checkIsLoggedIn(session.page);

    if (loggedIn) {
      console.log("🎉 Trạng thái: ĐÃ ĐĂNG NHẬP SẴN SÀNG! Bạn có thể tạo ảnh ngay.");
    } else {
      console.log("⚠️ Trạng thái: CHƯA ĐĂNG NHẬP. Vui lòng chạy `bun run login` để đăng nhập.");
      hasError = true;
    }
  } catch (err) {
    hasError = true;
    console.error("❌ Lỗi kiểm tra:", err instanceof Error ? err.message : err);
  } finally {
    await session.close();
    process.exit(hasError ? 1 : 0);
  }
}

void runTest();
