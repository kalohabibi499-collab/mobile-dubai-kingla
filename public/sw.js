// Pass-through service worker — no caching, no fetch interception.
// This replaces any previously cached SW that may have enforced a
// restrictive Content-Security-Policy blocking external resources.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
// No fetch handler — all requests fall through to the network normally.
