# Security notes

## Production secrets
Never commit `.env`. Configure these in Render > Environment:
- `MONGODB_URI`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD` (16+ characters, unique)
- `SESSION_SECRET` (Render Blueprint generates this automatically)

If a previous ZIP containing `.env` was shared with anyone, rotate the MongoDB password and admin password before deployment.

## What is protected
- Mode 1, Mode 2, Make Video, application JS/CSS/assets, animation media, upload media, APIs, and WebSocket rooms require a live server-side account session.
- Animation media is stored outside `public/` and streamed only after authentication.
- Uploaded decoration media is stored in MongoDB GridFS, not Render's temporary filesystem.
- Sessions are random, server-side MongoDB records protected by an independent `SESSION_SECRET`; logout revokes the exact session immediately.
- Password resets invalidate existing sessions for that account, and changing the configured admin password invalidates existing admin sessions.
- State-changing API calls and WebSocket upgrades enforce same-origin access in production.
- Login and TikTok profile calls are rate limited.
- Security headers include CSP, HSTS, anti-framing, no-sniff, referrer and permissions policies.
- TikTok avatar proxying is limited to approved TikTok/ByteDance CDN hosts to reduce SSRF risk.

## Important limitation
No website can make browser-delivered HTML/CSS/JS impossible to inspect or copy. Security therefore keeps valuable data, credentials, media and authorization on the server so a copied frontend is not a working clone.

## Repository
Use a PRIVATE GitHub repository. A public repository makes the source downloadable regardless of website protections.
