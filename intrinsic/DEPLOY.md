# Intrinsic — free hosting options

The app is a single Python process with no native dependencies, so it fits
almost any free tier. Pick one of the three routes below.

---

## 1. Free PaaS with a free web service (easiest, no credit card on some tiers)

Platforms that can build a Dockerfile for free or near-free:

| Platform | Free offering | Notes |
|---|---|---|
| **Render** | Free web service (spins down after ~15 min idle, cold start ~30–60 s) | Deploy from a Git repo; pick *Docker*; set health check path `/healthz` |
| **Fly.io** | Small free allowance, needs a card for verification | `fly launch` reads the Dockerfile; set internal port 8000 |
| **Koyeb** | Free web service tier | Docker build, port 8000 |
| **Railway** | Trial credit, then paid | Docker build, port from `$PORT` |

The app already reads `PORT` and binds `0.0.0.0` when it is set, so
platforms can inject their own port.

**Render walkthrough**

1. Push the `intrinsic` folder to a GitHub repository (keep `static/`, `data/`, `server.py`, `Dockerfile`).
2. Render → **New → Web Service** → connect the repo.
3. Runtime: **Docker**. Health check path: `/healthz`.
4. Deploy. You get a URL like `https://intrinsic.onrender.com`.

> **If the build fails with `failed to read dockerfile: open Dockerfile: no such file or directory`**, the files landed one folder too deep. Either re-upload the *contents* of the folder (so `Dockerfile` sits at the repository root), or set Render's **Root Directory** to the folder that contains it. A `.zip` uploaded as a single file will always fail this way.

Free instances sleep when idle; the first visit after a nap is slow but the
app itself needs no database or login.

**Optional hardening on a public deploy**

Everything below is off by default and set in the platform's environment-variable dashboard — never in the repository:

| Variable | Purpose |
|---|---|
| `INTRINSIC_PASSWORD` | Require a Basic-auth login before anything loads |
| `INTRINSIC_USERNAME` | Username for that login |
| `INTRINSIC_DIAG=1` | Enable `/api/diag` to see which upstream calls fail on that host |
| `INTRINSIC_RATE_LIMIT` | Requests per minute per client (default 120) |

If the valuation endpoint misbehaves on the host, set `INTRINSIC_DIAG=1`, open `/api/diag`, and read which check fails — then turn it off again.

---

## 2. Free container hosting by CLI

```bash
cd intrinsic
docker build -t intrinsic .
docker run -p 8000:8000 intrinsic     # http://localhost:8000
```

Then push the image to any registry (Docker Hub free tier, GitHub Container
Registry free for public images) and point a free host at it.

---

## 3. Free tunnel to your own PC (no hosting account)

Good for private use or a quick demo. Your PC must stay on.

```bash
# Cloudflare Tunnel (free, no port forwarding, gives an https URL)
cloudflared tunnel --url http://localhost:8765
```

Run the app first with:

```powershell
cd intrinsic
.\start.ps1 --host 0.0.0.0
```

The tunnel prints a `https://…trycloudflare.com` URL that works from any
device. The URL changes each time you restart the tunnel.

---

## Tips for a free public deployment

- **Locked down by default.** Strict security headers, rate limiting, hidden version, redacted errors and read-only routes are already on. Set `INTRINSIC_PASSWORD` if you want a login prompt. See [SECURITY.md](SECURITY.md).
- **Cache limits.** The free tiers have small ephemeral disks. Saved snapshots
  in `cache/` disappear on redeploy — that is fine, the app refetches.
- **Rate limits.** Yahoo endpoints are public but rate-limited. Keep the
  default 15-minute valuation cache; the LIVE toggle's 45-second quote cache is
  what keeps refresh cheap.
- **If the vendor blocks the host** (some datacentre IPs), the app falls back
  to the bundled snapshots in `data/fallback/` and labels them "Demo snapshot".
- **Don't add secrets.** There are no API keys to manage. If you later add a
  paid provider, keep its key in the platform dashboard, never in Git.

---

## What is free vs. not

- Free: the app, its data (public endpoints), and the hosting routes above.
- Not free: guaranteed uptime, custom domains on some platforms, or running a
  paid always-on instance. A free instance is fine for personal use and demos.
