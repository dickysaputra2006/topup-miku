## 2026-06-28 - Added ARIA labels to modal close buttons
**Learning:** Icon-only modal close buttons using HTML entities like &times; are widely read as "multiplication" or other mathematical operators by screen readers if not properly labeled. In this app, multiple modal components had this issue.
**Action:** Always add explicit aria-label="Tutup modal" (or similar contextual label) when building or reviewing icon-only close buttons.
