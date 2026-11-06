# Security

Intrinsic is a read-only valuation viewer. It stores no accounts, no user data and no payment information.
This document states what it does and does not hold, and what protects a public deployment.

## There are no API keys

Intrinsic needs **no API key, token or password** to run. It reads public Yahoo Finance endpoints the same way a browser does.

You can verify this yourself:

```powershell
# Windows PowerShell - search the whole project for credential-like strings
Get-ChildItem -Recurse -File -Include *.py,*.js,*.html,*.json,*.md |
  Select-String -Pattern 'api[_-]?key|secret|token|password|bearer|sk-|ghp_|AKIA'
```

The only matches are documentation sentences explaining that no keys are needed. Nothing is loaded from a `.env` file, and the code contains no hard-coded credential.

Because there is nothing to hide, there is no `.env` to leak and no key to rotate. If you later add a paid data provider that requires a key, keep it in a platform environment variable and never in the repository.

## Optional password

Set one environment variable to put the whole site behind a login prompt:

| Variable | Effect |
|---|---|
| `INTRINSIC_PASSWORD` | When set, every request needs HTTP Basic credentials |
| `INTRINSIC_USERNAME` | Username for that login (default `intrinsic`) |

```bash
INTRINSIC_PASSWORD='choose-something-long' INTRINSIC_USERNAME='me' python server.py
```

Comparison is constant-time, so response timing cannot be used to guess the password. Leave the variable unset for frictionless local use.

## What is enabled by default

| Control | Behaviour |
|---|---|
| **Rate limiting** | 120 requests per minute per client address, returning `429` with `Retry-After`. Stops the public URL being scripted as a free proxy against upstream data. Adjust with `INTRINSIC_RATE_LIMIT` (clamped to 10–5000). |
| **Security headers** | Strict `Content-Security-Policy` (no inline scripts), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` disabling device APIs, plus cross-origin isolation headers. |
| **No version disclosure** | The `Server` header says `Intrinsic` with no version number, so an attacker cannot match known bugs. |
| **Error redaction** | Exceptions are logged on the server with a short reference. Visitors receive a plain message and that reference — never a stack trace, file path or upstream URL. |
| **Input validation** | Ticker symbols are validated against a strict pattern before use; search queries are length-capped. |
| **No directory listing** | Unknown paths return `404`. Static file serving is confined to the `static` directory, with path traversal rejected. |
| **No CORS** | No `Access-Control-Allow-Origin` is sent, so other websites cannot read this server's responses from a browser. |
| **No write endpoints** | The server only answers `GET`. There is no form, upload, or state-changing route to attack. |

## Diagnostics

`/api/diag` reports which upstream calls fail on the host. It is **off by default** because it exposes upstream detail.

```bash
INTRINSIC_DIAG=1 python server.py    # then open /api/diag
```

Turn it off again once a deployment is healthy.

## Checklist before publishing

- [ ] No `.env` file in the repository
- [ ] Environment variables set in the platform dashboard, not committed
- [ ] `INTRINSIC_DIAG` unset in production
- [ ] Optional: `INTRINSIC_PASSWORD` set if the link should not be public
- [ ] `/api/health` returns only `ok`, `version` and a timestamp

## Reporting

This is a personal project with no production users. If you spot a problem, open an issue in the repository.

## Not covered

- **Upstream trust.** Valuations are only as good as the public data behind them. A wrong number here is a data-quality problem, not a security breach.
- **Availability.** On a free hosting tier the service sleeps when idle and the first request is slow. That is a platform behaviour, not a fault.
