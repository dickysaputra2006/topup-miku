## 2026-06-20 - Fix XSS in script.js innerHTML
**Vulnerability:** Unsanitized user inputs (game name, notification messages, product names) rendered via innerHTML in frontend/script.js.
**Learning:** Even though `escapeHtml` was available, it wasn't used everywhere, allowing potential XSS payloads to execute.
**Prevention:** Always use `escapeHtml` for any user-controlled input before passing it to `innerHTML`, or use `textContent` instead.
