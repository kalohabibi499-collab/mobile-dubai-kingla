# Deployment (Vercel frontend + persistent Node backend)

The project has a MongoDB-backed Node server, private animation streams and WebSocket handling. Vercel alone is not a drop-in host for these features. Deploy the Node server to a persistent host (for example Render) with env vars, then host the website at the backend URL.

To set up Vercel for a static frontend: set the project root to `public`, framework preset `Other`, no build command, and output directory `.`. Run `npx vercel` and `npx vercel --prod` from `public`. The static site will open but API login, protected gifts, admin and cross-device sync will NOT work without backend proxy routing.

Full-featured deploy: use a persistent Node hosting service for server.js, set MONGODB_URI, MONGODB_DB, ADMIN_USERNAME, ADMIN_PASSWORD (16+ chars), SESSION_SECRET (32+ chars), PUBLIC_ORIGIN (your HTTPS URL), then npm install / npm start. Open the resulting HTTPS URL in Chrome for install. Do not commit .env.

PWA installs need HTTPS or localhost (192.168.x.x over HTTP does not qualify as secure context). Android Chrome: menu > Add to Home screen / Install app.
