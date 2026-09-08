
# ChatGPT Web Reverse Engineering
- Khi gặp vấn đề liên quan đến DOM thay đổi, element selector, hoặc cấu trúc network request/response,etc..., nói chung là mấy vấn đề mà phải soi thẳng vào web chatgpt.com thì PHẢI BẮT BUỘC phải yêu cầu và hướng dẫn chi tiết dev chui vào lấy data từ trình duyệt thật.
- CẤM AI tự ý dùng headless browser/automation tool để cào hoặc inspect trực tiếp `chatgpt.com` (tránh dính Cloudflare, WAF, Turnstile và rác token).
- Toàn bộ phần oauth login session cookie token của chatgpt web phần lớn được tham khảo từ: https://github.com/miuuyy/codex-chatgpt-web . Khi thực sự cần thay đổi hay có lỗi thì hãy clone về mà dùng codegraph tham khảo 
- 
# Chatgpt Web Free (seperate với Codex)
- Dev đang tập trung vào làm phần chatgpt web chứ không phải codex hay gemini, hãy mặc định là đang code phần chatgpt web khi đang làm việc
- Cơ chế tạo ảnh của chatgpt.com đã thay đổi rất nhiều so với data training của bạn, mọi quy trình trong project này đang phục vụ cho cơ chế tạo ảnh mới nhất đó, hãy thật cẩn trọng trong việc xác thực thông tin mới nhất 
- Project này reverse engineer, giả lập user thật, vào web chatgpt.com để tạo ảnh

- start-all.bat : chỉ chạy cái này để bật app, user đã bật sẵn

## Chatgpt.com web imagen behavior
- 1 lần req tạo ảnh trên web có thể tạo nhiều ảnh 1 lúc, và nó sẽ không trả lần lượt mà sẽ trả 1 cục ảnh
- nó có thể trả về text thay vì ảnh vì những lí do như: safety strict; prompt sai
- nó có thể trả về cả text và cả (một hoặc nhiều) ảnh
- nó có thể trả về một hoặc nhiều ảnh cùng lúc và không trả về text (expect behavior)
- nó có thể tạo ảnh nhanh hoặc lâu
- Temporary chat không hỗ trợ tạo ảnh
- 
## Edge case có thể xảy ra
- Nó tạo ra nhiều ảnh 1 lúc khi mình chỉ cần 1 ảnh
- Khi mình cần nhiều ảnh thì nó lại hiểu lầm, tạo 1 ảnh với multi-panel
- mất mạng, user bấm linh tinh, lỗi bên server openai
- Hiếm: web thay đổi DOM/element,etc...
