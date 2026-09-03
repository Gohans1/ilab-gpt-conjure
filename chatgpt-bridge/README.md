# 🎨 ChatGPT Image CLI & Local OpenAI Bridge

CLI độc lập và Local API Bridge server tạo ảnh chất lượng cao từ **ChatGPT Web (ChatGPT Images 2.0 / GPT Image)** bằng tự động hóa trình duyệt qua Playwright. Không tốn phí API OpenAI, lưu trọn vẹn ảnh gốc 1254x1254.

---

## ⚡ Tính năng nổi bật

1. **Persistent Session (Chrome độc lập):** Mở Chrome thật và lưu session riêng vĩnh viễn tại `~/.chatgpt-image-cli/profile`. Đăng nhập 1 lần duy nhất.
2. **Bắt trọn gói 1 đến 8 ảnh:** Tự động phát hiện và tải hàng loạt toàn bộ ảnh mới sinh ra trong lượt chat (độ phân giải gốc `p=fs`, không dính thumbnail).
3. **Chống lỗi 403 Forbidden:** Tải ảnh bằng hàm `fetch()` trực tiếp trong browser context, xuất ra file `.png` độ phân giải gốc.
4. **OpenAI-Compatible Local Bridge:** Tích hợp sẵn HTTP server chuẩn OpenAI (`/v1/images/generations`), cho phép cắm thẳng vào **iLab CONJURE** hoặc bất kỳ WebUI/Client nào hỗ trợ OpenAI Images API.
5. **Bảo mật & Hàng đợi an toàn:** Khóa lắng nghe `127.0.0.1`, xác thực Bearer Token, hàng đợi FIFO chống xung đột `SingletonLock` của Chromium.

---

## 🚀 Cài đặt & Chuẩn bị

Mở terminal trong thư mục `C:\Users\ADMIN\Desktop\chatgpt-image-cli`:

```bash
# Cài đặt dependencies
bun install
```

---

## 📖 Hướng dẫn sử dụng

### 1. Đăng nhập tài khoản ChatGPT (Làm 1 lần đầu)
- Nháy đúp vào file `Run-Login.bat`
- Hoặc chạy lệnh:
```bash
bun login
```
Đăng nhập tài khoản ChatGPT trên cửa sổ Chrome vừa mở. Sau khi đăng nhập xong, session sẽ được lưu vĩnh viễn.

### 2. Tạo ảnh trực tiếp bằng CLI
- Nháy đúp vào file `Run-Generate.bat`
- Hoặc chạy lệnh dòng lệnh:
```bash
# Tạo ảnh tự động (lưu vào ./output/)
bun run src/cli.ts "Vẽ một chú mèo phi hành gia phong cách cyberpunk, tỉ lệ 16:9"

# Đặt đường dẫn file lưu cụ thể
bun run src/cli.ts "Vẽ logo quả táo kim loại phong cách tối giản" -o ./apple_logo.png

# Chạy ngầm (headless)
bun run src/cli.ts "A futuristic city in clouds" --headless
```

### 3. Chạy Local Bridge Server (Tích hợp iLab CONJURE)
- Nháy đúp vào file `Run-Server.bat`
- Hoặc chạy lệnh:
```bash
bun run server
```
Server sẽ lắng nghe tại: `http://127.0.0.1:3000/v1`

**Cấu hình trong iLab CONJURE (Settings -> API Settings -> Add Provider):**
- **Tên:** `ChatGPT Web Free`
- **Base URL:** `http://127.0.0.1:3000/v1`
- **API Key:** `sk-local`
- **Model:** `gpt-image-2`
- **Protocol:** `Images API (/images/generations)`
