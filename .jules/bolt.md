## 2025-02-20 - Debouncing Vanilla JS Inputs
**Learning:** In a vanilla HTML/JS setup without a bundler, sharing utility functions like `debounce` across multiple files natively requires either polluting the global namespace or complex ES Module setups which may not be supported by the current environment's server setup.
**Action:** For small, isolated utility functions like `debounce`, it is safer and simpler to define them locally within the file's `DOMContentLoaded` event listener to prevent global namespace pollution, unless a formal module system or bundler is introduced.
