import { getBrowserSession } from "./browser.js";
import { CHATGPT_URL, SELECTORS } from "./config.js";

async function runTest() {
  console.log("🔍 Đang kiểm tra kết nối trình duyệt và trạng thái đăng nhập ChatGPT...");
  const session = await getBrowserSession({ headless: true });
  let hasError = false;

  try {
    console.log(`✅ Đã khởi chạy Chrome thành công!`);
    console.log(`🌐 Đang mở trang: ${CHATGPT_URL}...`);
    await session.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const composerVisible = await session.page
      .locator(SELECTORS.composer)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    const loginVisible = await session.page
      .locator(SELECTORS.loginButton)
      .first()
      .isVisible({ timeout: 2000 })
      .catch(() => false);

    if (composerVisible) {
      console.log("🎉 Trạng thái: ĐÃ ĐĂNG NHẬP SẴN SÀNG! Bạn có thể tạo ảnh ngay.");
    } else if (loginVisible) {
      console.log("⚠️ Trạng thái: CHƯA ĐĂNG NHẬP. Vui lòng chạy `bun run login` để đăng nhập.");
    } else {
      console.log("ℹ️ Trạng thái: Đang tải giao diện hoặc cần kiểm tra thêm.");
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
