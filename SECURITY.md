# Security boundaries

pi-websocket is a remote-control interface to a Pi process, not a read-only transcript viewer, sandbox, or multi-tenant service.

## Deployment

- Keep authentication enabled. Configuration must include your own allowed email addresses and SMTP account; examples are placeholders.
- The current server listens on all interfaces. `PI_WS_AUTH=off` does not switch it to loopback. Never expose an unauthenticated instance to an untrusted network.
- Use HTTPS and a trusted reverse-proxy/network boundary for remote access. Forwarded client-IP headers are trusted only from loopback sockets; restrict who can reach that proxy and who may supply its forwarded headers.
- Anyone who can log in can submit tasks to Pi under its existing OS permissions. An empty `allowExec` blocks the direct command channel, not Pi's model-driven tools.
- Do not allow shells or interpreters in `allowExec`. Keep extra `publishRoots` narrow.
- Email/session allowlists do not isolate users. Authenticated clients share the current session and file store.

## Data and credentials

- The stream and history may include user messages, thinking, tool arguments/results, command output, local paths, and uploaded files. There is no general secret-redaction layer.
- Text truncation and JSON sanitization are size/serialization controls, not credential filtering.
- Login sessions, OTP codes and temporary lockouts are process-local. Uploads/published files and metadata are stored on disk; Pi's own session persistence is separate.
- Keep real configuration private (0600 where supported). Do not commit SMTP passwords, API keys, sessions, screenshots of real conversations, uploads, or logs.
- Command audit output may contain an email address and a command-argument prefix. Treat operational logs as private.
- File-type checks and attachment download headers are not antivirus scanning. Only open trusted attachments.

## Reporting concerns

Do not disclose working credentials or private conversation content in public issues. Until the repository owner provides a private reporting channel, reproduce issues locally with synthetic accounts/files and share only a minimal redacted description. Do not probe anyone else's running instance.

## Scope

Offline mock tests are not a full security audit or proof of compatibility with every Pi version, operating system, proxy, or browser. Review your deployment before granting access.
