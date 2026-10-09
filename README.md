# Dubai King Guest Live — Secure Render Build

This build is prepared for deployment as a Node.js Web Service on Render.

## Security model

The public internet only gets the login portal and its small login assets before authentication. Mode 1, Mode 2, Make Video, app CSS/JS/assets, animation files, APIs, uploaded decoration media, and WebSocket rooms require a live account session checked against MongoDB.

Sessions are server-side MongoDB records. Cookies are HttpOnly + SameSite=Strict and Secure in production. Logout revokes the current session on the server. Password changes invalidate old sessions. State-changing API requests and WebSocket upgrades enforce same-origin access in production.

Gift animation files are under `private/animation/`, not `public/`. Decoration uploads are stored in MongoDB GridFS so they persist across Render restarts without relying on Render's local filesystem.

## Local run

1. Copy `.env.example` to `.env`.
2. Fill in `MONGODB_URI`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET`.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000/` if `PORT=3000`.

`ADMIN_PASSWORD` must be at least 16 characters. `SESSION_SECRET` must be at least 32 characters and should be random.

## Render

See `RENDER-DEPLOY.md`. The included `render.yaml` configures the Node Web Service, health check, production mode, required secrets, and generated session secret.

## Important

Use a PRIVATE GitHub repository. Never commit `.env`. If an older ZIP containing `.env` was shared, rotate those credentials before deployment.

Browser-delivered frontend code can never be made impossible to inspect. This build protects the useful backend, account access, media and application routes so copying the visible frontend does not create a working clone.
