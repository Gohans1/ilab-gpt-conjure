#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { generateImage } from "./generator.js";
import { getBrowserSession } from "./browser.js";
import { CHATGPT_URL, SELECTORS } from "./config.js";

function printHelp(): void {
  console.log(`
🎨 ChatGPT Image CLI (ChatGPT Images 2.0 / GPT Image) 🎨

Cách sử dụng:
  bun run src/cli.ts "Nội dung prompt tạo ảnh" [options]
  node src/cli.js "Nội dung prompt tạo ảnh" [options]

Options:
  -o, --out <path>     Đường dẫn file ảnh đầu ra (Mặc định: ./output/image_<timestamp>.png)
  --headless           Chạy trình duyệt ẩn (không mở cửa sổ giao diện)
  --headed             Ép mở cửa sổ trình duyệt (mặc định)
  --login              Mở trình duyệt để bạn đăng nhập tài khoản ChatGPT
  -h, --help           Hiện trợ giúp này

Ví dụ:
  bun run src/cli.ts "Vẽ một chú mèo phi hành gia phong cách cyberpunk, tỉ lệ 16:9" -o ./cat.png
`);
}

async function handleLogin(): Promise<void> {
  console.log("🔑 [Login Mode] Đang mở Chrome để bạn đăng nhập ChatGPT...");
  const session = await getBrowserSession({ headless: false });
  try {
    const page = session.page;
    await page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
    console.log(`👉 Trình duyệt đã mở tại: ${CHATGPT_URL}`);
    console.log("👉 Vui lòng đăng nhập vào tài khoản ChatGPT của bạn trên cửa sổ này.");
    console.log("⏳ Đang chờ bạn đăng nhập xong...");

    await page.locator(SELECTORS.composer).first().waitFor({ state: "visible", timeout: 300_000 });
    console.log("\n🎉 Đăng nhập thành công! Phiên đăng nhập đã được lưu lại vĩnh viễn.");
    console.log("Bạn có thể tắt trình duyệt và bắt đầu dùng lệnh tạo ảnh bình thường.");
  } finally {
    await session.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--login")) {
    await handleLogin();
    process.exit(0);
  }

  let prompt = "";
  let outputPath = "";
  let headless = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-o" || arg === "--out") {
      outputPath = args[++i] || "";
    } else if (arg === "--headless") {
      headless = true;
    } else if (arg === "--headed") {
      headless = false;
    } else if (!arg.startsWith("-") && !prompt) {
      prompt = arg;
    }
  }

  if (!prompt) {
    console.error("❌ Lỗi: Bạn chưa nhập prompt tạo ảnh!");
    printHelp();
    process.exit(1);
  }

  const resolvedOut = outputPath ? resolve(process.cwd(), outputPath) : undefined;

  console.log("=================================================");
  console.log("🚀 Bắt đầu tạo ảnh với ChatGPT Web Images...");
  console.log(`📝 Prompt: "${prompt}"`);
  if (resolvedOut) console.log(`💾 File đích: ${resolvedOut}`);
  console.log("=================================================\n");

  try {
    const startTime = Date.now();
    const results = await generateImage(prompt, {
      outputPath: resolvedOut,
      headless,
    });
    const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log("\n=================================================");
    console.log(`🎉 TẠO ẢNH THÀNH CÔNG RỰC RỠ! (Tổng cộng: ${results.length} ảnh)`);
    results.forEach((res, index) => {
      console.log(`  [Ảnh #${index + 1}] 📁 ${res.filePath} (${(res.sizeBytes / 1024).toFixed(1)} KB)`);
    });
    console.log(`⏱️ Thời gian thực hiện: ${durationSec}s`);
    console.log("=================================================");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ ĐÃ XẢY RA LỖI:");
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void main();
