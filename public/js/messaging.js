/* ──────────────────────────────────────────────────────────────────────────
   Messaging transport.

   Fast paths:
     • BroadcastChannel/localStorage for tabs on the same device
     • WebSocket when the host supports a shared long-lived socket process

   Reliable deployed path:
     • MongoDB-backed /api/remote/send + /api/remote/poll

   The MongoDB relay is what makes Mode 1 on a laptop and Mode 2 on a phone
   work on Vercel even when the two browsers land on different function
   instances. All transports carry the same _msgId/ts so duplicate deliveries
   can be ignored safely by the page.
   ────────────────────────────────────────────────────────────────────────── */
(function initMessagingModule() {
  window.App = window.App || { modules: {} };

  const channelName = "tiktok-room-control";
  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(channelName) : null;
  const fallbackKey = "tiktok-room-control-message";

  let ws = null;
  let wsQueue = [];
  let onMessage = null;
  let shouldReconnect = () => true;

  let apiRoomId = null;
  let apiPollTimer = null;
  let apiPollInFlight = false;
  let apiSince = Date.now() - 8000;
  const apiSeen = new Set();
  const apiSeenOrder = [];
  const apiClientId = (() => {
    try {
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  })();

  function makeMessageId() {
    try {
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function rememberApiEvent(id) {
    if (!id || apiSeen.has(id)) return false;
    apiSeen.add(id);
    apiSeenOrder.push(id);
    while (apiSeenOrder.length > 1200) {
      const old = apiSeenOrder.shift();
      apiSeen.delete(old);
    }
    return true;
  }

  function emit(message) {
    if (!message || typeof message !== "object") return;
    if (onMessage) onMessage(message);
  }

  function getWsUrl(roomId) {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws?room=${encodeURIComponent(roomId)}`;
  }

  async function loadApiState() {
    if (!apiRoomId) return;
    try {
      const res = await fetch("/api/remote/state", {
        credentials: "include",
        cache: "no-store"
      });
      if (!res.ok) return;
      const data = await res.json();
      (Array.isArray(data.messages) ? data.messages : []).forEach(emit);
    } catch (_) {
      // Polling will retry automatically.
    }
  }

  async function sendApi(message) {
    if (!apiRoomId || !message) return;
    try {
      const res = await fetch("/api/remote/send", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: apiClientId, message })
      });
      if (!res.ok) return;
      const data = await res.json();
      // host-profile-request can be answered immediately from MongoDB state,
      // even if the other device is temporarily asleep.
      (Array.isArray(data.stateMessages) ? data.stateMessages : []).forEach(emit);
    } catch (_) {
      // WebSocket/local transports may still be available; the next action
      // will retry the API path.
    }
  }

  function scheduleApiPoll(delay) {
    if (apiPollTimer) clearTimeout(apiPollTimer);
    if (!apiRoomId) return;
    apiPollTimer = setTimeout(pollApiOnce, delay);
  }

  async function pollApiOnce() {
    if (!apiRoomId || apiPollInFlight) {
      scheduleApiPoll(document.hidden ? 900 : 320);
      return;
    }
    apiPollInFlight = true;
    try {
      const url = `/api/remote/poll?clientId=${encodeURIComponent(apiClientId)}&since=${encodeURIComponent(apiSince)}`;
      const res = await fetch(url, {
        credentials: "include",
        cache: "no-store"
      });
      if (res.ok) {
        const data = await res.json();
        const events = Array.isArray(data.events) ? data.events : [];
        for (const event of events) {
          if (!event || !rememberApiEvent(event.id)) continue;
          const createdAt = Number(event.createdAt || 0);
          if (Number.isFinite(createdAt) && createdAt > apiSince) apiSince = createdAt;
          emit(event.message);
        }
        const serverNow = Number(data.now || 0);
        // Do not jump beyond an event timestamp. A small overlap on the server
        // plus event-id dedupe prevents races between Vercel instances.
        if (!events.length && Number.isFinite(serverNow) && serverNow > apiSince) {
          apiSince = Math.max(apiSince, serverNow - 1200);
        }
      }
    } catch (_) {
      // transient network failure
    } finally {
      apiPollInFlight = false;
      scheduleApiPoll(document.hidden ? 900 : 320);
    }
  }

  function connectApi(roomId) {
    if (!roomId) return;
    if (apiRoomId === roomId && apiPollTimer) return;
    apiRoomId = roomId;
    apiSince = Date.now() - 8000;
    apiSeen.clear();
    apiSeenOrder.length = 0;
    loadApiState().finally(() => {
      // Mirror WebSocket's ready signal so existing host/remote hydration logic
      // works even when the WebSocket path is unavailable on the deployment.
      setTimeout(() => emit({ type: "ws-ready", room: roomId, _via: "mongo-ready", ts: Date.now() }), 50);
    });
    scheduleApiPoll(20);
  }

  function connectWs(roomId) {
    if (!roomId) return;
    // Always bring up the durable relay. It is independent of the WS state.
    connectApi(roomId);

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(getWsUrl(roomId));
    } catch (_) {
      return;
    }
    ws.addEventListener("open", () => {
      const queued = wsQueue.splice(0);
      queued.forEach((msg) => sendWs(msg));
    });
    ws.addEventListener("message", (event) => {
      try {
        const msg = JSON.parse(event.data);
        emit(msg);
      } catch (_) {
        // ignore malformed transport packet
      }
    });
    ws.addEventListener("close", () => {
      setTimeout(() => {
        if (shouldReconnect()) connectWs(roomId);
      }, 2000);
    });
  }

  function sendWs(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(message)); } catch (_) {}
      return;
    }
    if (message && wsQueue.length < 100) wsQueue.push(message);
  }

  function closeWs() {
    try { if (ws) ws.close(); } catch (_) {}
    ws = null;
    wsQueue = [];
    apiRoomId = null;
    if (apiPollTimer) clearTimeout(apiPollTimer);
    apiPollTimer = null;
  }

  function post(payload) {
    if (channel) {
      channel.postMessage(payload);
    } else {
      try { localStorage.setItem(fallbackKey, JSON.stringify(payload)); } catch (_) {}
    }
  }

  function normalizeOutgoing(payload) {
    const ts = Number(payload && payload.ts);
    return {
      ...(payload || {}),
      ts: Number.isFinite(ts) ? ts : Date.now(),
      _msgId: (payload && payload._msgId) || makeMessageId()
    };
  }

  function send(payload) {
    const message = normalizeOutgoing(payload);
    post(message);
    sendWs(message);
    void sendApi(message);
    return message;
  }

  window.App.bus = {
    channel,
    fallbackKey,
    configure(opts) {
      if (opts && typeof opts.onMessage === "function") onMessage = opts.onMessage;
      if (opts && typeof opts.shouldReconnect === "function") shouldReconnect = opts.shouldReconnect;
    },
    connectWs,
    sendWs,
    closeWs,
    post,
    send,
  };
})();
