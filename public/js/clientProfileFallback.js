/*
 * clientProfileFallback.js
 * ─────────────────────────────────────────────────────────────────
 * Browser-side TikTok profile fallback.
 *
 * WHY: The server runs on a datacenter host (Render) whose IP range is
 * WAF-blocked by TikTok, so the server-side embed/page scrapers return
 * empty avatars for most accounts. Residential/browser IPs and edge
 * nodes (Cloudflare Workers) are NOT blocked. This helper runs in the
 * customer's browser to resolve a profile when the server cannot.
 *
 * HOW: TikTok doesn't send CORS headers, so the browser can't read
 * tiktok.com directly via fetch(). We relay the /embed/@user page
 * through a CORS proxy. That page contains a
 * __FRONTITY_CONNECT_STATE__ JSON blob with the real avatar URL,
 * nickname, and follower count.
 *
 * PROXY: Set WORKER_URL below to your own Cloudflare Worker (see
 * cf-worker-tiktok-proxy.js for setup — 5 min, 100% free, no rate
 * limits). If WORKER_URL is empty, the helper falls back to public
 * proxies, which are less reliable.
 *
 * SHARE: A successful lookup is POSTed back to /api/tiktok/profile-cache
 * so the server caches it for every other customer — the cache grows
 * itself, so popular accounts become instant for everyone after one
 * customer resolves them.
 * ───────────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CONFIG: set WORKER_URL to your deployed Cloudflare Worker URL.
  // Example: "https://tiktok-proxy.yourname.workers.dev"
  // Leave empty to use only the public proxy fallbacks (less reliable).
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Each Cloudflare account has its own daily request quota, so list every
  // worker you've deployed. A random pick per page-load spreads customers
  // across the accounts; the /avatar lookup below also fails over to the
  // others if the chosen one errors or is out of quota.
  const WORKER_URLS = [
    'https://tiktok-proxy.billxamelie.workers.dev',
    'https://tiktok-proxy.factsecret99.workers.dev',
  ];
  const WORKER_URL = WORKER_URLS.length
    ? WORKER_URLS[Math.floor(Math.random() * WORKER_URLS.length)]
    : '';

  // Dedupe concurrent lookups for the same handle.
  const inflight = new Map(); // lowercase username -> Promise

  // Public CORS proxies used ONLY as fallbacks when WORKER_URL is unset or
  // the worker fails. Order = priority. These are community proxies and can
  // rate-limit / go down — the Worker is the reliable path.
  const PUBLIC_PROXIES = [
    (target) => `https://proxy.cors.sh/${target}`,
    (target) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(target)}`,
    (target) => `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
    (target) => `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
  ];

  function normalize(raw) {
    if (!raw) return '';
    return String(raw).trim().replace(/^@+/, '');
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
  }

  // Extract { name, avatar, followers, likes } from the embed-page HTML by
  // parsing the __FRONTITY_CONNECT_STATE__ blob (mirrors server scrapeEmbed).
  function parseEmbedHtml(html, username) {
    if (!html) return null;
    const m = html.match(/<script[^>]*id="__FRONTITY_CONNECT_STATE__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m || !m[1]) return null;
    let state;
    try { state = JSON.parse(m[1]); } catch { return null; }

    const sd = state?.source?.data || {};
    const lower = username.toLowerCase();
    const key = Object.keys(sd).find((k) => k.toLowerCase().includes(lower));
    const entry = key ? sd[key] : null;
    // Some accounts (private/restricted/new) make the embed page return an
    // error object instead of userInfo. Detect that so the caller can try a
    // different strategy.
    if (!entry || entry.isError || !entry.userInfo) return null;
    const ui = entry.userInfo || {};
    if (!ui.avatarThumbUrl && !ui.nickname) return null;

    let avatarRaw = ui.avatarThumbUrl || ui.avatarMedium || ui.avatarLarger || '';
    if (typeof avatarRaw === 'string') avatarRaw = avatarRaw.replace(/\\u0026/g, '&');

    return {
      name: ui.nickname || username,
      avatar: avatarRaw,
      followers: ui.followerCount || 0,
      likes: ui.heartCount || 0,
    };
  }

  // Extract profile from the MAIN profile page HTML (/@user) by parsing the
  // __UNIVERSAL_DATA_FOR_REHYDRATION__ blob. This works for accounts that the
  // embed page rejects (rolandocp1224 etc.).
  function parseProfilePageHtml(html, username) {
    if (!html) return null;
    const m = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m || !m[1]) return null;
    let data;
    try { data = JSON.parse(m[1]); } catch { return null; }
    const info = data?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo;
    const user = info?.user;
    const stats = info?.stats;
    if (!user || (!user.avatarLarger && !user.nickname)) return null;

    const avatarRaw = user.avatarLarger || user.avatarMedium || user.avatarThumb || '';
    return {
      name: user.nickname || username,
      avatar: avatarRaw.replace(/\\u0026/g, '&'),
      followers: stats?.followerCount || 0,
      likes: stats?.heartCount || 0,
    };
  }

  // Parse the oEmbed JSON for at least the display name (no avatar available
  // for creator profiles). Used as a last resort so the capsule shows a name
  // plus a generated initial-avatar for restricted accounts.
  function parseOembedJson(text, username) {
    if (!text) return null;
    let j;
    try { j = JSON.parse(text); } catch { const m = text.match(/\{[\s\S]*\}/); if (!m) return null; try { j = JSON.parse(m[0]); } catch { return null; } }
    const name = j?.author_name || j?.title || '';
    if (!name) return null;
    // `generated: true` marks a PLACEHOLDER avatar (initial letter), not a real
    // profile picture — callers should keep it only until the real image
    // resolves, and must not cache it as final.
    return { name: String(name), avatar: generateInitialAvatar(name, username), followers: 0, likes: 0, generated: true };
  }

  // Generate a data-URI SVG avatar with the user's initial on a colored circle.
  // Used for restricted/private accounts where TikTok doesn't expose a real avatar.
  function generateInitialAvatar(name, username) {
    const initial = (String(name || username || '?').trim()[0] || '?').toUpperCase();
    // Deterministic color from the username string.
    let hash = 0;
    const src = String(username || name || '');
    for (let i = 0; i < src.length; i++) hash = src.charCodeAt(i) + ((hash << 5) - hash);
    const hue = Math.abs(hash) % 360;
    const bg = `hsl(${hue}, 65%, 45%)`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">` +
      `<circle cx="50" cy="50" r="50" fill="${bg}"/>` +
      `<text x="50" y="50" dy="0.35em" text-anchor="middle" font-family="Arial,sans-serif" font-size="48" font-weight="bold" fill="white">${initial}</text>` +
      `</svg>`;
    return 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  // Build the list of proxy-fetch functions to try, in priority order.
  function buildProxyList() {
    const list = [];
    if (WORKER_URL) {
      // Worker takes ?url=<target> and adds CORS headers + edge caching.
      const base = WORKER_URL.replace(/\/$/, '');
      list.push((target) => `${base}/?url=${encodeURIComponent(target)}`);
    }
    return list.concat(PUBLIC_PROXIES);
  }

  /*
   * tryProxy deliberately ignores the HTTP status, because some public proxies
   * answer 400/503 with a perfectly good body. But the WORKER passes TikTok's
   * own status straight through, and TikTok answers the oEmbed probe with 400
   * for a handle that does not exist. That is the one authoritative "no such
   * account" signal available to the browser, so it gets its own reader.
   */
  async function workerOembedProbe(target, username, perProxyMs) {
    if (!WORKER_URL) return {};
    const base = WORKER_URL.replace(/\/$/, '');
    try {
      const res = await withTimeout(fetch(`${base}/?url=${encodeURIComponent(target)}`, {
        headers: { Accept: 'application/json' },
      }), perProxyMs);
      if (res.status === 400) return { notFound: true };
      if (!res.ok) return {};
      return { parsed: parseOembedJson(await res.text(), username) };
    } catch {
      return {};
    }
  }

  async function tryProxy(proxyFn, target, username, perProxyMs, parser) {
    try {
      const res = await withTimeout(fetch(proxyFn(target), {
        headers: { Accept: 'text/html,application/json,*/*' },
      }), perProxyMs);
      // Some proxies (e.g. cors.sh) return non-200 status (400, 503) but still
      // include a valid body. Don't bail on status alone — read the body and
      // let the parser decide if it's usable.
      const text = await res.text();
      // Bail on WAF / overload challenge pages or tiny error stubs.
      if (
        text.length < 500 ||
        text.includes('wafchallengeid') ||
        text.includes('SlardarWAF') ||
        text.includes('Just a moment') ||
        text.includes('overload-protect')
      ) {
        return null;
      }
      return parser(text, username);
    } catch {
      return null;
    }
  }

  /**
   * Resolve a TikTok profile from the browser.
   * @param {string} rawHandle - e.g. "@teresitaoj" or "teresitaoj"
   * @param {object} [opts]
   * @param {string} [opts.apiBase] - server base for POST-back (default location.origin)
   * @param {number} [opts.timeoutMs] - total budget (default 12000)
   * @returns {Promise<{name:string, avatar:string, followers?:number, likes?:number}|null>}
   */
  async function resolveProfile(rawHandle, opts) {
    const clean = normalize(rawHandle);
    if (!clean) return null;
    const key = clean.toLowerCase();
    const o = opts || {};
    const apiBase = o.apiBase || (typeof location !== 'undefined' ? location.origin : '');
    const totalMs = o.timeoutMs || 9000;
    const proxies = buildProxyList();
    // Cap each proxy attempt so one slow proxy can't eat the whole budget.
    const perProxyMs = WORKER_URL ? 4000 : 2500;

    // Reuse an in-flight promise for the same handle.
    if (inflight.has(key)) return inflight.get(key);

    const work = (async () => {
      const embedTarget = `https://www.tiktok.com/embed/@${encodeURIComponent(clean)}`;
      const profileTarget = `https://www.tiktok.com/@${encodeURIComponent(clean)}`;
      const oembedTarget = `https://www.tiktok.com/oembed?url=https://www.tiktok.com/@${encodeURIComponent(clean)}`;

      // ── If a Cloudflare Worker is configured, try it FIRST for both the embed
      // page and the main profile page. The Worker runs on an edge node that
      // TikTok does NOT WAF-block, so it resolves accounts that public proxies
      // and the Render server cannot (e.g. rolandocp1224). This is the only
      // reliable path for WAF-protected accounts.
      if (WORKER_URL) {
        const workerProxy = proxies[0]; // WORKER_URL is always first in list
        // Embed page via worker.
        let parsed = await tryProxy(workerProxy, embedTarget, clean, perProxyMs, parseEmbedHtml);
        if (parsed && parsed.avatar) { postBack(apiBase, clean, parsed); return parsed; }
        // Main profile page via worker (for accounts embed rejects).
        parsed = await tryProxy(workerProxy, profileTarget, clean, perProxyMs, parseProfilePageHtml);
        if (parsed && parsed.avatar) { postBack(apiBase, clean, parsed); return parsed; }

        // Worker /avatar endpoint — uses tik.ninja to resolve avatars for
        // accounts TikTok restricts (error 209002/10101). This runs BEFORE
        // oEmbed because oEmbed returns a name-only result (with a generated
        // fallback avatar) that would mask this real avatar.
        // Try the chosen worker first, then the others — so one account being
        // down or out of quota doesn't cost us the lookup.
        const avatarWorkers = [WORKER_URL].concat(
          WORKER_URLS.filter(function (u) { return u !== WORKER_URL; })
        );
        for (var wi = 0; wi < avatarWorkers.length; wi++) {
          try {
            const avatarApi = avatarWorkers[wi].replace(/\/$/, '') + '/avatar?user=' + encodeURIComponent(clean);
            const aRes = await withTimeout(fetch(avatarApi, { headers: { Accept: 'application/json' } }), 8000);
            if (!aRes.ok) continue; // quota/worker error -> next account
            const aData = await aRes.json();
            if (aData && aData.avatar) {
              const result = {
                name: aData.nickname || clean,
                avatar: aData.avatar,
                followers: aData.followers || 0,
                likes: 0,
              };
              postBack(apiBase, clean, result);
              return result;
            }
            // A "no avatar" answer is NOT authoritative — workers disagree in
            // practice (one can return source:"none" while another returns the
            // real avatar for the same handle at the same moment). Fall through
            // to the next worker instead of giving up here.
          } catch (e) { /* network error -> next account */ }
        }

        // oEmbed via worker (name only, no real avatar) — and the only
        // authoritative existence check we get. A typo used to fall through
        // every remaining public proxy, producing a wall of console errors and
        // several seconds of waiting before returning a placeholder anyway.
        const probe = await workerOembedProbe(oembedTarget, clean, perProxyMs);
        if (probe.notFound) {
          return {
            name: clean,
            avatar: generateInitialAvatar(clean, clean),
            followers: 0,
            likes: 0,
            generated: true,
            notFound: true,
          };
        }
        if (probe.parsed && probe.parsed.name) return probe.parsed;
      }

      // ── Public-proxy fallback (no Worker). The embed page works for most
      // accounts; the main profile page usually WAF-fails through public
      // proxies, so we skip it here to avoid long timeouts.
      for (const proxyFn of proxies) {
        if (WORKER_URL && proxyFn === proxies[0]) continue; // already tried worker
        const parsed = await tryProxy(proxyFn, embedTarget, clean, perProxyMs, parseEmbedHtml);
        if (parsed && parsed.avatar) { postBack(apiBase, clean, parsed); return parsed; }
      }

      // Retry the first couple of public proxies once (transient overload).
      await new Promise((r) => setTimeout(r, 600));
      for (const proxyFn of proxies.slice(0, 3)) {
        const parsed = await tryProxy(proxyFn, embedTarget, clean, perProxyMs, parseEmbedHtml);
        if (parsed && parsed.avatar) { postBack(apiBase, clean, parsed); return parsed; }
      }

      // ── Last resort: oEmbed for the display name. parseOembedJson already
      // generates an initial-avatar, so we get name + fallback avatar here.
      for (const proxyFn of proxies.slice(0, 3)) {
        const parsed = await tryProxy(proxyFn, oembedTarget, clean, perProxyMs, parseOembedJson);
        if (parsed && parsed.name) return parsed;
      }
      // Absolute last resort: PLACEHOLDER avatar with the username initial.
      return { name: clean, avatar: generateInitialAvatar(clean, clean), followers: 0, likes: 0, generated: true };
    })().then((result) => proxyAvatar(result, apiBase));

    inflight.set(key, work);
    try {
      return await work;
    } finally {
      inflight.delete(key);
    }
  }

  /**
   * Route a raw TikTok CDN avatar through our own /api/tiktok/avatar proxy.
   *
   * WHY: the browser loading p16-…tiktokcdn-us.com directly is fragile — some
   * users' networks/ISPs block the TikTok CDN outright (broken image even though
   * the URL is valid and returns 200 elsewhere), and the raw host must also be
   * whitelisted in the page CSP. Serving it same-origin sidesteps both, and the
   * server can refresh/cache the bytes when the signed URL expires.
   * data: URLs (generated initial avatars) and already-proxied paths are left as-is.
   */
  function proxyAvatar(result, apiBase) {
    if (!result || !result.avatar) return result;
    const a = String(result.avatar);
    if (a.startsWith('data:') || a.indexOf('/api/tiktok/avatar') !== -1) return result;
    if (!/^https:\/\/[^/]*tiktok(cdn[^.]*|cdn-[^.]*|img)?\.com\//i.test(a)) return result;
    const base = (apiBase || '').replace(/\/$/, '');
    return { ...result, avatar: `${base}/api/tiktok/avatar?url=${encodeURIComponent(a)}` };
  }

  function postBack(apiBase, username, data) {
    try {
      if (!apiBase) return;
      const url = `${apiBase.replace(/\/$/, '')}/api/tiktok/profile-cache`;
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, nickname: data.name || '', avatar: data.avatar || '' }),
        keepalive: true,
      }).catch(() => { /* best-effort */ });
    } catch { /* ignore */ }
  }

  global.ClientProfileFallback = { resolveProfile };
})(typeof window !== 'undefined' ? window : globalThis);
