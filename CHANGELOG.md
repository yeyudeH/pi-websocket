# Changelog

## 1.0.0 — public release candidate

- Browser-based Pi chat, optional streaming, recent branch replay and theme synchronization.
- Email allowlist and SMTP one-time-code login; in-memory auth state.
- Image/file upload and authenticated publication tools.
- Model, thinking, tool-selection and session-control commands; direct executable commands disabled by default.
- Generic sample accounts and branding; no host-specific configuration or historical backup files.
- Exact npm publication allowlist and private/runtime file ignore rules.
- Portable offline fixtures using loopback listeners and unique temporary directories.

The extension runtime is preserved from the existing implementation. This candidate prepares a distributable source tree; it does not introduce automatic conversation redaction, multi-user isolation, or a localhost-only production bind.
