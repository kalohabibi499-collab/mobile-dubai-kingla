const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { MongoClient, ObjectId, GridFSBucket } = require("mongodb");

const ROOT = __dirname;
const STATIC_ROOT = fs.existsSync(path.join(ROOT, "public")) ? path.join(ROOT, "public") : ROOT;
const PRIVATE_ROOT = path.join(ROOT, "private");
const ANIMATION_DIR = path.join(PRIVATE_ROOT, "animation");
const MAX_DECOR_UPLOAD_BYTES = 100 * 1024 * 1024;
const PORT = Number(process.env.PORT || 8787);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL || "";
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "dubai_king_guest_live";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
let db;
let usersCollection;
let layoutsCollection;
let sessionsCollection;
let remoteEventsCollection;
let remoteStateCollection;
let uploadsBucket;
let uploadsFilesCollection;

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 16 || !SESSION_SECRET || SESSION_SECRET.length < 32 || !MONGODB_URI) {
  console.error("Missing secure configuration. Set MONGODB_URI, ADMIN_USERNAME, ADMIN_PASSWORD (16+ chars), and SESSION_SECRET (32+ chars).");
  process.exit(1);
}

async function connectDatabase() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(MONGODB_DB);
  usersCollection = db.collection("users");
  layoutsCollection = db.collection("layouts");
  sessionsCollection = db.collection("sessions");
  remoteEventsCollection = db.collection("remoteEvents");
  remoteStateCollection = db.collection("remoteState");
  uploadsBucket = new GridFSBucket(db, { bucketName: "decorUploads" });
  uploadsFilesCollection = db.collection("decorUploads.files");
  await usersCollection.createIndex({ username: 1 }, { unique: true });
  await layoutsCollection.createIndex({ key: 1 }, { unique: true });
  await sessionsCollection.createIndex({ tokenHash: 1 }, { unique: true });
  await sessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await sessionsCollection.createIndex({ userId: 1 });
  // Cross-device relay is persisted in MongoDB so Mode 1 and Mode 2 still
  // communicate when Vercel sends the two devices to different function instances.
  await remoteEventsCollection.createIndex({ room: 1, createdAt: 1 });
  await remoteEventsCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
  await remoteStateCollection.createIndex({ room: 1 }, { unique: true });
  const adminUsername = ADMIN_USERNAME.toLowerCase();
  const existingAdmin = await usersCollection.findOne({ username: adminUsername });
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  // Keep admin bootstrap/update conflict-free. MongoDB rejects an upsert that
  // targets the same field with both $setOnInsert and $inc (authVersion).
  if (!existingAdmin) {
    await usersCollection.insertOne({
      username: adminUsername,
      passwordHash,
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      durationMinutes: null,
      expiresAt: null,
      authVersion: 0
    });
  } else {
    const adminPasswordChanged = !(await bcrypt.compare(ADMIN_PASSWORD, existingAdmin.passwordHash || ""));
    const update = {
      $set: { passwordHash, role: "admin", updatedAt: new Date() }
    };
    if (adminPasswordChanged) update.$inc = { authVersion: 1 };
    await usersCollection.updateOne({ _id: existingAdmin._id }, update);
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".vrm": "model/gltf-binary"
};

function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(data);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function getSessionToken(req) {
  return String(parseCookies(req).dk_session || "");
}

function sessionTokenHash(token) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(token).digest("hex");
}

function createSessionCookie(token) {
  const secure = process.env.NODE_ENV === "production" || process.env.RENDER ? "; Secure" : "";
  return `dk_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

async function createServerSession(user, expiresAtMs) {
  const token = crypto.randomBytes(32).toString("base64url");
  const record = {
    tokenHash: sessionTokenHash(token),
    userId: user._id,
    username: user.username,
    role: user.role,
    authVersion: Number(user.authVersion || 0),
    createdAt: new Date(),
    lastSeen: new Date(),
    expiresAt: new Date(expiresAtMs)
  };
  await sessionsCollection.insertOne(record);
  return { token, record };
}

async function revokeSession(req) {
  const token = getSessionToken(req);
  if (!token) return;
  await sessionsCollection.deleteOne({ tokenHash: sessionTokenHash(token) }).catch(() => {});
}

async function validateSession(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  const tokenHash = sessionTokenHash(token);
  const session = await sessionsCollection.findOne({ tokenHash });
  if (!session || !session.expiresAt || new Date(session.expiresAt).getTime() <= Date.now()) {
    if (session) await sessionsCollection.deleteOne({ _id: session._id }).catch(() => {});
    return null;
  }
  const user = await usersCollection.findOne({ _id: session.userId });
  if (!user || user.username !== session.username || user.role !== session.role) return null;
  if (Number(user.authVersion || 0) !== Number(session.authVersion || 0)) return null;
  if (user.role !== "admin") {
    if (user.expiresAt && new Date(user.expiresAt).getTime() <= Date.now()) return null;
    if (user.isActive === false && user.expiresAt) return null;
  }
  const now = new Date();
  if (!session.lastSeen || now.getTime() - new Date(session.lastSeen).getTime() > 60_000) {
    sessionsCollection.updateOne({ _id: session._id }, { $set: { lastSeen: now } }).catch(() => {});
  }
  return {
    id: String(user._id), username: user.username, role: user.role,
    authVersion: Number(user.authVersion || 0), expiresAt: new Date(session.expiresAt).getTime(),
    accountExpiresAt: user.expiresAt || null, makeVideoOnly: Boolean(user.makeVideoOnly),
    addonEnabled: Boolean(user.addonEnabled)
  };
}

async function requireSession(req, res, api = false) {
  const session = await validateSession(req);
  if (session) return session;
  if (api) json(res, 401, { error: "Authentication required" });
  else redirect(res, "/portal.html");
  return null;
}

async function requireAdmin(req, res) {
  const session = await requireSession(req, res, true);
  if (!session) return null;
  if (session.role !== "admin") {
    json(res, 403, { error: "Admin access required" });
    return null;
  }
  return session;
}

function clearSessionCookie() {
  const secure = process.env.NODE_ENV === "production" || process.env.RENDER ? "; Secure" : "";
  return `dk_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function requestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket?.remoteAddress || "unknown";
}

function sameOrigin(req, origin) {
  try {
    const candidate = new URL(origin);
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
    return candidate.host.toLowerCase() === host;
  } catch { return false; }
}

function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return process.env.NODE_ENV !== "production" && !process.env.RENDER;
  if (sameOrigin(req, origin)) return true;
  const allowed = new Set(String(PUBLIC_ORIGIN || "").split(",").map(v => v.trim()).filter(Boolean));
  return allowed.has(origin);
}

function enforceOrigin(req, res) {
  if (originAllowed(req)) return true;
  json(res, 403, { error: "Request origin is not allowed" });
  return false;
}

function applySecurityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://*.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https:",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "media-src 'self' blob: data: https://res.cloudinary.com https://*.cloudinary.com",
    "connect-src 'self' blob: data: ws: wss: https://cdn.jsdelivr.net https://*.jsdelivr.net https://api.cloudinary.com https://res.cloudinary.com https://*.cloudinary.com https://*.tiktok.com https://*.tiktokcdn.com https://*.tiktokcdn-us.com https://*.tiktokcdn-eu.com https://*.tiktokv.com https://*.tiktokstaticb.com https://tiktok-proxy.billxamelie.workers.dev https://tiktok-proxy.factsecret99.workers.dev https://proxy.cors.sh https://api.codetabs.com https://api.allorigins.win https://corsproxy.io https://thingproxy.freeboard.io",
    "worker-src 'self' blob:",
    "manifest-src 'self'"
  ].join("; "));
  if (process.env.NODE_ENV === "production" || process.env.RENDER) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

const rateBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfter: 0 };
  }
  current.count += 1;
  if (current.count > limit) return { allowed: false, remaining: 0, retryAfter: Math.ceil((current.resetAt - now) / 1000) };
  return { allowed: true, remaining: Math.max(0, limit - current.count), retryAfter: 0 };
}

function enforceRateLimit(req, res, bucket, limit, windowMs) {
  const result = rateLimit(`${bucket}:${requestIp(req)}`, limit, windowMs);
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  if (result.allowed) return true;
  res.setHeader("Retry-After", String(result.retryAfter));
  json(res, 429, { error: "Too many requests. Please try again later." });
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateBuckets) if (value.resetAt <= now) rateBuckets.delete(key);
}, 10 * 60 * 1000).unref();

function publicUser(user) {
  return {
    id: String(user._id),
    username: user.username,
    role: user.role,
    durationMinutes: user.durationMinutes || null,
    expiresAt: user.expiresAt || null,
    isActive: Boolean(user.isActive),
    lastLogin: user.lastLogin || null,
    lastSeen: user.lastSeen || null,
    addonEnabled: Boolean(user.addonEnabled),
    makeVideoOnly: Boolean(user.makeVideoOnly),
    tiktokUsername: user.tiktokUsername || ""
  };
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(new Error("Request body too large"));
        // Continue draining the request so the browser receives a useful 413
        // response instead of a network-level "Failed to fetch" error.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}


function cleanRemoteClientId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 120);
}

function safeRemoteMessage(raw, room, via = "mongo") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // Re-serialize once so prototypes/functions cannot leak into MongoDB.
  let plain;
  try {
    const encoded = JSON.stringify(raw);
    if (!encoded || Buffer.byteLength(encoded, "utf8") > 2_000_000) return null;
    plain = JSON.parse(encoded);
  } catch (_) {
    return null;
  }
  return {
    ...plain,
    _room: room,
    _via: via,
    _serverTs: Date.now()
  };
}

async function persistRemoteState(room, message) {
  if (!remoteStateCollection || !room || !message) return;
  const set = { updatedAt: new Date() };
  if (message.type === "host-profile-sync" || message.type === "gift-capsule-host") {
    set.profile = {
      type: "host-profile-sync",
      name: String(message.name || message.username || "Host").trim().slice(0, 120) || "Host",
      username: String(message.username || "").replace(/^@+/, "").trim().slice(0, 80),
      avatar: String(message.avatar || "").slice(0, 10000),
      ts: Date.now()
    };
  } else if (message.type === "cam-name-text" && typeof message.text === "string") {
    const current = await remoteStateCollection.findOne({ room }, { projection: { profile: 1 } }).catch(() => null);
    set.profile = {
      ...(current?.profile || {}),
      type: "host-profile-sync",
      name: String(message.text || "Host").trim().slice(0, 120) || "Host",
      username: String(current?.profile?.username || "").slice(0, 80),
      avatar: String(current?.profile?.avatar || "").slice(0, 10000),
      ts: Date.now()
    };
  } else if (message.type === "remote-seats" && Array.isArray(message.seats)) {
    set.seats = message.seats.slice(0, 12).map((seat) => {
      if (!seat || typeof seat !== "object") return null;
      return {
        handle: String(seat.handle || "").slice(0, 80),
        name: String(seat.name || seat.handle || "").slice(0, 120),
        avatar: String(seat.avatar || "").slice(0, 10000),
        followers: seat.followers ?? null,
        likes: seat.likes ?? null,
        points: Number.isFinite(Number(seat.points)) ? Number(seat.points) : 0,
        videoMode: !!seat.videoMode,
        videoSrc: String(seat.videoSrc || "").slice(0, 600)
      };
    });
  } else if (message.type === "seat-profile-sync" && message.seat) {
    const current = await remoteStateCollection.findOne({ room }, { projection: { seats: 1 } }).catch(() => null);
    const seats = Array.isArray(current?.seats) ? current.seats.slice(0, 12) : [];
    const idx = Number(message.index);
    if (Number.isInteger(idx) && idx >= 0 && idx < 12) {
      seats[idx] = { ...(seats[idx] || {}), ...(message.seat || {}) };
      set.seats = seats;
    }
  }
  if (Object.keys(set).length > 1) {
    await remoteStateCollection.updateOne({ room }, { $set: set, $setOnInsert: { room, createdAt: new Date() } }, { upsert: true }).catch(() => {});
  }
}

function remoteStateMessages(state, room) {
  const out = [];
  if (state?.profile) {
    out.push({ ...state.profile, type: "host-profile-sync", _room: room, _via: "mongo-state", _serverTs: Date.now() });
    out.push({
      type: "gift-capsule-host",
      name: state.profile.name || state.profile.username || "Host",
      username: state.profile.username || "",
      avatar: state.profile.avatar || "",
      _room: room,
      _via: "mongo-state",
      _serverTs: Date.now(),
      ts: Number(state.profile.ts || Date.now())
    });
    if (state.profile.name) {
      out.push({ type: "cam-name-text", text: state.profile.name, _room: room, _via: "mongo-state", _serverTs: Date.now(), ts: Number(state.profile.ts || Date.now()) });
    }
  }
  if (Array.isArray(state?.seats)) {
    out.push({ type: "remote-seats", seats: state.seats, _room: room, _via: "mongo-state", _serverTs: Date.now(), ts: Date.now() });
  }
  return out;
}

const decorMediaTypes = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["video/quicktime", "mov"]
]);

async function saveDecorMedia(dataUrl, resourceType, ownerUsername) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) throw new Error("Invalid media data");

  const mimeType = match[1].toLowerCase();
  const extension = decorMediaTypes.get(mimeType);
  if (!extension) throw new Error("Unsupported image or video type");
  if (resourceType !== "image" && resourceType !== "video") throw new Error("Invalid media type");
  if ((resourceType === "video") !== mimeType.startsWith("video/")) throw new Error("Media type does not match file");

  const content = Buffer.from(match[2], "base64");
  if (!content.length) throw new Error("The selected file is empty");
  if (content.length > MAX_DECOR_UPLOAD_BYTES) throw new Error("Files must be 100 MB or smaller");

  const filename = `${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const upload = uploadsBucket.openUploadStream(filename, { metadata: { mimeType, resourceType, ownerUsername: String(ownerUsername || ""), createdAt: new Date() } });
  await new Promise((resolve, reject) => {
    upload.once("error", reject);
    upload.once("finish", resolve);
    upload.end(content);
  });
  return `/api/uploads/decorations/${upload.id}`;
}

function safeFile(base, relative) {
  const resolved = path.resolve(base, relative);
  return resolved === base || resolved.startsWith(base + path.sep) ? resolved : null;
}

function streamFile(req, res, filePath) {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    json(res, 404, { error: "File not found" });
    return;
  }
  const stat = fs.statSync(filePath);
  const type = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); res.end(); return; }
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }); res.end(); return; }
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600"
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": /\.(?:html|js|css)$/i.test(filePath) ? "no-store" : "private, max-age=900"
  });
  fs.createReadStream(filePath).pipe(res);
}

const allowedAvatarSuffixes = [
  ".tiktokcdn.com", ".tiktokcdn-us.com", ".tiktokcdn-eu.com", ".byteimg.com",
  ".ibyteimg.com", ".byteoversea.com", ".muscdn.com"
];
function isAllowedAvatarUrl(value) {
  try {
    const u = new URL(value);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || !host || host === "localhost" || host.endsWith(".local")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    return allowedAvatarSuffixes.some(suffix => host.endsWith(suffix));
  } catch { return false; }
}

async function fetchAllowedAvatar(value) {
  let current = value;
  for (let i = 0; i < 4; i++) {
    if (!isAllowedAvatarUrl(current)) throw new Error("Avatar host is not allowed");
    const response = await fetch(current, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Invalid avatar redirect");
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  throw new Error("Too many avatar redirects");
}

function avatarProxyPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return isAllowedAvatarUrl(raw) ? `/api/tiktok/avatar?url=${encodeURIComponent(raw)}` : raw;
}

async function fetchTikTokProfile(username) {
  const clean = String(username || "").trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,32}$/.test(clean)) throw new Error("Invalid TikTok username");
  const response = await fetch(`https://www.tiktok.com/@${encodeURIComponent(clean)}`, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  const html = await response.text();
  const universal = html.match(/<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (universal) {
    const data = JSON.parse(universal[1]);
    const user = data?.__DEFAULT_SCOPE__?.["webapp.user-detail"]?.userInfo?.user;
    if (user) return { username: user.uniqueId || clean, nickname: user.nickname || user.uniqueId || clean, avatar: avatarProxyPath(user.avatarLarger || user.avatarThumb || "") };
  }
  const sigi = html.match(/<script[^>]*id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (sigi) {
    const data = JSON.parse(sigi[1]);
    const user = Object.values(data?.UserModule?.users || {})[0];
    if (user) return { username: user.uniqueId || clean, nickname: user.nickname || user.uniqueId || clean, avatar: avatarProxyPath(user.avatarLarger || user.avatarThumb || "") };
  }
  throw new Error(`TikTok profile unavailable (${response.status})`);
}

const databaseReady = connectDatabase();

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(req, res);
  try {
    await databaseReady;
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === "/healthz" && req.method === "GET") { json(res, 200, { ok: true }); return; }
    if (["POST", "PATCH", "DELETE", "PUT"].includes(req.method || "") && pathname.startsWith("/api/") && !enforceOrigin(req, res)) return;

    if (pathname === "/api/auth/login" && req.method === "POST") {
      if (!enforceRateLimit(req, res, "login", 8, 15 * 60 * 1000)) return;
      const body = await readBody(req);
      const username = String(body.username || "").trim().toLowerCase();
      const user = await usersCollection.findOne({ username });
      if (!user || !(await bcrypt.compare(String(body.password || ""), user.passwordHash))) {
        json(res, 401, { error: "Invalid username or password" });
        return;
      }
      const now = new Date();
      let expiresAt = user.expiresAt || null;
      if (user.role !== "admin" && !expiresAt && user.durationMinutes) {
        expiresAt = new Date(now.getTime() + Number(user.durationMinutes) * 60_000);
      }
      if (user.role !== "admin" && expiresAt && new Date(expiresAt) <= now) {
        json(res, 403, { error: "Access expired. Contact admin." });
        return;
      }
      await usersCollection.updateOne({ _id: user._id }, { $set: { expiresAt, lastLogin: now, lastSeen: now, isActive: true } });
      const accountExpiryMs = expiresAt ? new Date(expiresAt).getTime() : Infinity;
      const sessionExpiresAt = Math.min(Date.now() + SESSION_TTL_MS, accountExpiryMs);
      const createdSession = await createServerSession(user, sessionExpiresAt);
      json(res, 200, { ok: true }, { "Set-Cookie": createSessionCookie(createdSession.token) });
      return;
    }
    if (pathname === "/api/auth/status" && req.method === "GET") {
      const session = await validateSession(req);
      if (session) {
        await usersCollection.updateOne({ _id: new ObjectId(session.id) }, { $set: { lastSeen: new Date() } }).catch(() => {});
      }
      json(res, 200, session ? {
        authenticated: true,
        user: {
          username: session.username,
          role: session.role,
          makeVideoOnly: Boolean(session.makeVideoOnly),
          addonEnabled: Boolean(session.addonEnabled),
          expiresAt: session.expiresAt,
          accountExpiresAt: session.accountExpiresAt
        }
      } : { authenticated: false });
      return;
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      await revokeSession(req);
      json(res, 200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
      return;
    }
    if (pathname === "/api/users" && req.method === "GET") {
      if (!(await requireAdmin(req, res))) return;
      const users = await usersCollection.find({}).sort({ createdAt: -1 }).toArray();
      json(res, 200, { users: users.map(publicUser) });
      return;
    }
    if (pathname === "/api/users" && req.method === "POST") {
      if (!(await requireAdmin(req, res))) return;
      const body = await readBody(req);
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      const durationMinutes = Number(body.duration);
      if (!/^[a-z0-9_.-]{3,32}$/.test(username)) { json(res, 400, { error: "Username must be 3–32 letters, numbers, dots, dashes, or underscores." }); return; }
      if (password.length < 8) { json(res, 400, { error: "Password must be at least 8 characters." }); return; }
      if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 525600) { json(res, 400, { error: "Invalid access duration." }); return; }
      try {
        const result = await usersCollection.insertOne({
          username,
          passwordHash: await bcrypt.hash(password, 12),
          role: "user",
          durationMinutes,
          expiresAt: null,
          isActive: false,
          addonEnabled: Boolean(body.addonEnabled),
          makeVideoOnly: Boolean(body.makeVideoOnly),
          createdAt: new Date(),
          updatedAt: new Date()
        });
        json(res, 201, { success: true, id: String(result.insertedId) });
      } catch (error) {
        json(res, error?.code === 11000 ? 409 : 500, { error: error?.code === 11000 ? "Username already exists." : "Unable to create user." });
      }
      return;
    }
    if (pathname === "/api/users/expired" && req.method === "DELETE") {
      if (!(await requireAdmin(req, res))) return;
      const result = await usersCollection.deleteMany({ role: { $ne: "admin" }, expiresAt: { $lte: new Date() } });
      json(res, 200, { success: true, message: `${result.deletedCount} expired user(s) removed.` });
      return;
    }
    const userRoute = pathname.match(/^\/api\/users\/([a-f0-9]{24})(?:\/(extend|addon|makevideo-only|play-gift))?$/i);
    if (userRoute) {
      if (!(await requireAdmin(req, res))) return;
      const _id = new ObjectId(userRoute[1]);
      const action = userRoute[2] || "profile";
      if (req.method === "DELETE" && action === "profile") {
        const result = await usersCollection.deleteOne({ _id, role: { $ne: "admin" } });
        json(res, result.deletedCount ? 200 : 404, result.deletedCount ? { success: true } : { error: "User not found." });
        return;
      }
      if (req.method === "PATCH" && action === "profile") {
        const body = await readBody(req);
        const password = String(body.password || "");
        if (password.length < 8) { json(res, 400, { error: "Password must be at least 8 characters." }); return; }
        await usersCollection.updateOne({ _id, role: { $ne: "admin" } }, { $set: { passwordHash: await bcrypt.hash(password, 12), updatedAt: new Date() }, $inc: { authVersion: 1 } });
        json(res, 200, { success: true });
        return;
      }
      if (req.method === "PATCH" && action === "extend") {
        const body = await readBody(req);
        const days = Number(body.days);
        const user = await usersCollection.findOne({ _id, role: { $ne: "admin" } });
        if (!user || !Number.isFinite(days)) { json(res, 400, { error: "Invalid user or number of days." }); return; }
        const base = user.expiresAt && new Date(user.expiresAt) > new Date() ? new Date(user.expiresAt) : new Date();
        const expiresAt = new Date(base.getTime() + days * 86_400_000);
        await usersCollection.updateOne({ _id }, { $set: { expiresAt, isActive: expiresAt > new Date(), updatedAt: new Date() } });
        json(res, 200, { success: true, expiresAt });
        return;
      }
      if (req.method === "PATCH" && (action === "addon" || action === "makevideo-only")) {
        const body = await readBody(req);
        const field = action === "addon" ? "addonEnabled" : "makeVideoOnly";
        await usersCollection.updateOne({ _id, role: { $ne: "admin" } }, { $set: { [field]: Boolean(body.enabled), updatedAt: new Date() } });
        json(res, 200, { success: true });
        return;
      }
      if (req.method === "POST" && action === "play-gift") {
        json(res, 200, { success: true, delivered: 0, local: true });
        return;
      }
    }
    if (pathname === "/api/layout" && req.method === "GET") {
      const session = await requireSession(req, res, true);
      if (!session) return;
      const requestedKey = String(url.searchParams.get("key") || "default").slice(0, 80);
      const key = `${session.username}:${requestedKey}`;
      const record = await layoutsCollection.findOne({ key });
      json(res, 200, { ok: true, style: record?.style || null });
      return;
    }
    if (pathname === "/api/layout" && req.method === "POST") {
      const session = await requireSession(req, res, true);
      if (!session) return;
      const body = await readBody(req);
      const requestedKey = String(body.key || "default").slice(0, 80);
      const key = `${session.username}:${requestedKey}`;
      await layoutsCollection.updateOne(
        { key },
        { $set: { style: body.style || body.data || body, updatedAt: new Date() } },
        { upsert: true }
      );
      json(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/upload-decorate" && req.method === "POST") {
      const session = await requireSession(req, res, true);
      if (!session) return;
      if (!enforceRateLimit(req, res, `decorate-upload:${session.username}`, 12, 60 * 60 * 1000)) return;
      try {
        // Base64 adds roughly one third to the original file size.
        const body = await readBody(req, Math.ceil(MAX_DECOR_UPLOAD_BYTES * 1.4) + 1024);
        const url = await saveDecorMedia(body.dataUrl, body.resourceType, session.username);
        json(res, 201, { ok: true, url });
      } catch (error) {
        const message = error?.message || "Unable to save media";
        const status = /too large|100 MB/i.test(message) ? 413 : 400;
        json(res, status, { error: message });
      }
      return;
    }
    // Vercel-safe cross-device relay.
    // WebSocket is kept as a fast path, while this MongoDB relay guarantees
    // phone ↔ laptop delivery even when Vercel uses separate function instances.
    if (pathname === "/api/remote/send" && req.method === "POST") {
      const session = await requireSession(req, res, true);
      if (!session) return;
      try {
        const body = await readBody(req, 2_100_000);
        const clientId = cleanRemoteClientId(body.clientId);
        const safe = safeRemoteMessage(body.message, session.username, "mongo");
        if (!safe) { json(res, 400, { error: "Invalid remote message" }); return; }
        const createdAt = new Date();
        const result = await remoteEventsCollection.insertOne({
          room: session.username,
          clientId,
          message: safe,
          createdAt
        });
        await persistRemoteState(session.username, safe);

        let stateMessages = [];
        if (safe.type === "host-profile-request") {
          const state = await remoteStateCollection.findOne({ room: session.username }).catch(() => null);
          stateMessages = remoteStateMessages(state, session.username);
        }
        json(res, 200, { ok: true, id: String(result.insertedId), stateMessages });
      } catch (error) {
        const status = /too large/i.test(error?.message || "") ? 413 : 400;
        json(res, status, { error: error?.message || "Unable to relay message" });
      }
      return;
    }

    if (pathname === "/api/remote/poll" && req.method === "GET") {
      const session = await requireSession(req, res, true);
      if (!session) return;
      const clientId = cleanRemoteClientId(url.searchParams.get("clientId"));
      const sinceRaw = Number(url.searchParams.get("since") || 0);
      const now = Date.now();
      // Poll with overlap. Clients dedupe by event id, so this avoids missing
      // messages that land on different Vercel instances at the same millisecond.
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0
        ? Math.max(now - 60_000, sinceRaw - 2000)
        : now - 8000;
      const query = {
        room: session.username,
        createdAt: { $gte: new Date(since) }
      };
      if (clientId) query.clientId = { $ne: clientId };
      const events = await remoteEventsCollection
        .find(query)
        .sort({ createdAt: 1, _id: 1 })
        .limit(250)
        .toArray();
      json(res, 200, {
        ok: true,
        now,
        events: events.map((event) => ({
          id: String(event._id),
          createdAt: new Date(event.createdAt).getTime(),
          message: event.message
        }))
      });
      return;
    }

    if (pathname === "/api/remote/state" && req.method === "GET") {
      const session = await requireSession(req, res, true);
      if (!session) return;
      const state = await remoteStateCollection.findOne({ room: session.username }).catch(() => null);
      json(res, 200, { ok: true, messages: remoteStateMessages(state, session.username) });
      return;
    }

    if (pathname.startsWith("/api/tiktok/profile/") && req.method === "GET") {
      if (!(await requireSession(req, res, true))) return;
      if (!enforceRateLimit(req, res, "tiktok-profile", 90, 5 * 60 * 1000)) return;
      try { json(res, 200, { data: await fetchTikTokProfile(pathname.slice("/api/tiktok/profile/".length)) }); }
      catch (error) { json(res, 404, { error: error.message }); }
      return;
    }
    if (pathname === "/api/tiktok/avatar" && req.method === "GET") {
      if (!(await requireSession(req, res, true))) return;
      const target = url.searchParams.get("url");
      if (!target || !isAllowedAvatarUrl(target)) { json(res, 400, { error: "Invalid avatar URL" }); return; }
      const response = await fetchAllowedAvatar(target);
      res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") || "image/jpeg", "Cache-Control": "private, max-age=900" });
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const uploadMatch = pathname.match(/^\/api\/uploads\/decorations\/([a-f0-9]{24})$/i);
    if (uploadMatch && req.method === "GET") {
      const session = await requireSession(req, res, true);
      if (!session) return;
      const _id = new ObjectId(uploadMatch[1]);
      const file = await uploadsFilesCollection.findOne({ _id });
      if (!file) { json(res, 404, { error: "File not found" }); return; }
      const owner = String(file.metadata?.ownerUsername || "");
      if ((owner && owner !== session.username && session.role !== "admin") || (!owner && session.role !== "admin")) {
        json(res, 403, { error: "File access denied" });
        return;
      }
      const type = file.metadata?.mimeType || "application/octet-stream";
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match) { res.writeHead(416, { "Content-Range": `bytes */${file.length}` }); res.end(); return; }
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Math.min(Number(match[2]), file.length - 1) : file.length - 1;
        if (start > end || start >= file.length) { res.writeHead(416, { "Content-Range": `bytes */${file.length}` }); res.end(); return; }
        res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${file.length}`, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" });
        uploadsBucket.openDownloadStream(_id, { start, end: end + 1 }).on("error", () => res.end()).pipe(res);
      } else {
        res.writeHead(200, { "Content-Type": type, "Content-Length": file.length, "Accept-Ranges": "bytes", "Cache-Control": "private, no-store" });
        uploadsBucket.openDownloadStream(_id).on("error", () => res.end()).pipe(res);
      }
      return;
    }

    if (pathname.startsWith("/api/protected-media/") && req.method === "GET") {
      if (!(await requireSession(req, res, true))) return;
      streamFile(req, res, safeFile(ANIMATION_DIR, pathname.slice("/api/protected-media/".length)));
      return;
    }
    if (pathname.startsWith("/animation/") && req.method === "GET") {
      if (!(await requireSession(req, res, true))) return;
      streamFile(req, res, safeFile(ANIMATION_DIR, pathname.slice("/animation/".length)));
      return;
    }
    if (pathname === "/api/tiktok-live/status") { if (!(await requireSession(req, res, true))) return; json(res, 200, { connected: false, local: true }); return; }
    if (pathname === "/api/tiktok-live/start" || pathname === "/api/tiktok-live/stop") { if (!(await requireSession(req, res, true))) return; json(res, 200, { ok: true, local: true }); return; }

    if (pathname === "/") { redirect(res, "/portal.html"); return; }
    if ((pathname === "/mode1.html" || pathname === "/mode2.html" || pathname === "/makevideo.html") && !(await requireSession(req, res))) return;

    const publicAllowlist = new Set([
      "/portal.html", "/portal-clean.html", "/temp-auth.js", "/robots.txt", "/manifest.json",
      "/manifest-mode1.json", "/manifest-mode2.json", "/manifest-makevideo.json",
      "/image/tiktokicon.png", "/sw.js",
      "/image/contact-tiktok.webp", "/image/contact-instagram.webp", "/image/contact-telegram.webp",
      "/image/contact-discord.webp"
    ]);
    if (!publicAllowlist.has(pathname) && !pathname.startsWith("/api/") && pathname !== "/healthz") {
      if (!(await requireSession(req, res))) return;
    }

    let relative = pathname.replace(/^\/+/, "");
    if (relative.startsWith("image/")) {
      const requestedName = relative.slice("image/".length);
      const original = safeFile(STATIC_ROOT, relative);
      if ((!original || !fs.existsSync(original)) && fs.existsSync(path.join(ANIMATION_DIR, requestedName))) {
        streamFile(req, res, path.join(ANIMATION_DIR, requestedName));
        return;
      }
    }
    const protectedPage = pathname === "/mode1.html" || pathname === "/mode2.html";
    const rootHtmlPages = new Set(["makevideo.html", "mode1.html", "mode2.html"]);

    // public/ remains the normal static root. A few legacy app pages intentionally
    // live beside server.js, so serve only those explicitly allow-listed files.
    // This avoids exposing private root files such as .env, package files, or server.js.
    let staticPath = safeFile(STATIC_ROOT, relative);
    if ((!staticPath || !fs.existsSync(staticPath)) && rootHtmlPages.has(relative)) {
      staticPath = safeFile(ROOT, relative);
    }
    streamFile(req, res, staticPath);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: "Local server error" });
    else res.end();
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// Same-user cross-device remote sync
// Native WebSocket relay for Mode 1 (host) ⇄ Mode 2 (remote).
// Both pages connect to /ws?room=<username>; the server verifies the login
// session cookie and relays every command to the other devices in that room.
// This keeps the project dependency-free and works on laptop + mobile.
// ─────────────────────────────────────────────────────────────────────────────
const wsRooms = new Map(); // room -> Set<socket>
const wsRoomState = new Map(); // room -> { profile?: object, seats?: array, lastCamName?: string }

function wsAcceptKey(key) {
  return crypto
    .createHash("sha1")
    .update(String(key || "") + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

function wsFrame(data) {
  const payload = Buffer.from(String(data));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsCloseFrame(code = 1000, reason = "") {
  const reasonBuf = Buffer.from(String(reason));
  const payload = Buffer.alloc(2 + reasonBuf.length);
  payload.writeUInt16BE(code, 0);
  reasonBuf.copy(payload, 2);
  const header = Buffer.from([0x88, payload.length]);
  return Buffer.concat([header, payload]);
}

function wsPongFrame(payload = Buffer.alloc(0)) {
  const body = Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x8A, body.length]), body]);
  return Buffer.from([0x8A, 0]);
}

function parseWsFrames(socket, chunk, onText) {
  socket._wsBuffer = socket._wsBuffer ? Buffer.concat([socket._wsBuffer, chunk]) : Buffer.from(chunk);
  let offset = 0;
  const buffer = socket._wsBuffer;

  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let headerLen = 2;

    if (len === 126) {
      if (offset + 4 > buffer.length) break;
      len = buffer.readUInt16BE(offset + 2);
      headerLen = 4;
    } else if (len === 127) {
      if (offset + 10 > buffer.length) break;
      const bigLen = buffer.readBigUInt64BE(offset + 2);
      if (bigLen > BigInt(262_144)) throw new Error("WebSocket frame too large");
      len = Number(bigLen);
      headerLen = 10;
    }

    const maskLen = masked ? 4 : 0;
    const frameEnd = offset + headerLen + maskLen + len;
    if (frameEnd > buffer.length) break;

    let payload = buffer.subarray(offset + headerLen + maskLen, frameEnd);
    if (masked) {
      const mask = buffer.subarray(offset + headerLen, offset + headerLen + 4);
      const out = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }

    if (opcode === 0x1) {
      onText(payload.toString("utf8"));
    } else if (opcode === 0x8) {
      try { socket.write(wsCloseFrame()); } catch (_) {}
      socket.end();
      return;
    } else if (opcode === 0x9) {
      try { socket.write(wsPongFrame(payload)); } catch (_) {}
    }

    offset = frameEnd;
  }
  socket._wsBuffer = buffer.subarray(offset);
}

function sendWs(socket, message) {
  if (!socket || socket.destroyed) return;
  try { socket.write(wsFrame(message)); } catch (_) {}
}

function relayWs(room, sender, message) {
  const clients = wsRooms.get(room);
  if (!clients) return;
  for (const client of clients) {
    if (client !== sender && !client.destroyed) sendWs(client, message);
  }
}

function cleanupWs(socket) {
  const room = socket._wsRoom;
  if (!room) return;
  const clients = wsRooms.get(room);
  if (clients) {
    clients.delete(socket);
    if (!clients.size) wsRooms.delete(room);
  }
  socket._wsRoom = null;
}

server.on("upgrade", async (req, socket) => {
  try {
    await databaseReady;
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    if (!originAllowed(req)) { socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    const session = await validateSession(req);
    const requestedRoom = String(url.searchParams.get("room") || "").trim().toLowerCase();
    const sessionRoom = String(session?.username || "").trim().toLowerCase();
    const isAdmin = session?.role === "admin";

    // Normal users may only join their own room. Admin can join any named room,
    // but defaults to the admin username room when no room is provided.
    const room = requestedRoom || sessionRoom;
    if (!session || !room || (!isAdmin && room !== sessionRoom)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if ((wsRooms.get(room)?.size || 0) >= 6) { socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }

    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n` +
      "\r\n"
    );

    socket._wsRoom = room;
    socket._wsUser = sessionRoom;
    if (!wsRooms.has(room)) wsRooms.set(room, new Set());
    wsRooms.get(room).add(socket);
    sendWs(socket, JSON.stringify({ type: "ws-ready", room, clients: wsRooms.get(room).size, ts: Date.now() }));
    // If another device already sent the TikTok host/profile for this room,
    // immediately hydrate the newly opened host/remote tab. This fixes the
    // case where Mode 2 on mobile had the name before Mode 1 on laptop opened.
    try {
      const state = wsRoomState.get(room);
      if (state && state.profile) {
        sendWs(socket, JSON.stringify({ ...state.profile, type: "host-profile-sync", _room: room, _via: "ws-state", _serverTs: Date.now() }));
        sendWs(socket, JSON.stringify({ type: "gift-capsule-host", name: state.profile.name || state.profile.username || "Host", username: state.profile.username || "", avatar: state.profile.avatar || "", _room: room, _via: "ws-state", _serverTs: Date.now() }));
        if (state.profile.name) sendWs(socket, JSON.stringify({ type: "cam-name-text", text: state.profile.name, _room: room, _via: "ws-state", _serverTs: Date.now() }));
      }
      if (state && Array.isArray(state.seats)) {
        sendWs(socket, JSON.stringify({ type: "remote-seats", seats: state.seats, _room: room, _via: "ws-state", _serverTs: Date.now() }));
      }
    } catch (_) {}

    socket.on("data", (chunk) => {
      try {
        parseWsFrames(socket, chunk, (text) => {
          // Validate JSON so random text cannot be used as a broadcast channel.
          let parsed;
          try { parsed = JSON.parse(text); } catch (_) { return; }
          if (!parsed || typeof parsed !== "object") return;
          const safe = {
            ...parsed,
            _room: room,
            _via: "ws",
            _serverTs: Date.now()
          };
          // Persist the latest TikTok host profile/name for the room so a
          // second device can open later and still get the same profile.
          try {
            if (safe.type === "host-profile-sync" || safe.type === "gift-capsule-host") {
              const displayName = String(safe.name || safe.username || "Host").trim() || "Host";
              const username = String(safe.username || "").replace(/^@+/, "").trim();
              const prev = wsRoomState.get(room) || {};
              prev.profile = { type: "host-profile-sync", name: displayName, username, avatar: String(safe.avatar || "").slice(0, 10000), ts: Date.now() };
              wsRoomState.set(room, prev);
            } else if (safe.type === "cam-name-text" && typeof safe.text === "string") {
              const prev = wsRoomState.get(room) || {};
              const displayName = String(safe.text || "Host").trim() || "Host";
              prev.profile = { ...(prev.profile || {}), type: "host-profile-sync", name: displayName, username: (prev.profile && prev.profile.username) || "", avatar: String((prev.profile && prev.profile.avatar) || "").slice(0, 10000), ts: Date.now() };
              wsRoomState.set(room, prev);
            }
          } catch (_) {}
          // Persist the latest remote seat list too. This lets Mode 1 on a second
          // device hydrate with the same participants even if it opens after
          // Mode 2 has already added them.
          try {
            if (safe.type === "remote-seats" && Array.isArray(safe.seats)) {
              const prev = wsRoomState.get(room) || {};
              prev.seats = safe.seats.slice(0, 12).map((seat) => {
                if (!seat || typeof seat !== "object") return null;
                return {
                  handle: String(seat.handle || "").slice(0, 80),
                  name: String(seat.name || seat.handle || "").slice(0, 120),
                  avatar: String(seat.avatar || "").slice(0, 10000),
                  followers: seat.followers ?? null,
                  likes: seat.likes ?? null,
                  points: Number.isFinite(Number(seat.points)) ? Number(seat.points) : 0,
                  videoMode: !!seat.videoMode,
                  videoSrc: String(seat.videoSrc || "").slice(0, 600),
                };
              });
              wsRoomState.set(room, prev);
            } else if (safe.type === "seat-profile-sync" && safe.seat) {
              const prev = wsRoomState.get(room) || {};
              const list = Array.isArray(prev.seats) ? prev.seats.slice() : [];
              const idx = Number(safe.index);
              const seat = safe.seat || {};
              if (Number.isInteger(idx) && idx >= 0 && idx < 12) {
                list[idx] = { ...(list[idx] || {}), ...seat };
                prev.seats = list;
                wsRoomState.set(room, prev);
              }
            }
          } catch (_) {}
          // A profile request should get an immediate answer from server memory
          // too, even if the remote tab is asleep/reconnecting.
          if (safe.type === "host-profile-request") {
            try {
              const state = wsRoomState.get(room);
              if (state && state.profile) {
                sendWs(socket, JSON.stringify({ ...state.profile, type: "host-profile-sync", _room: room, _via: "ws-state", _serverTs: Date.now() }));
                sendWs(socket, JSON.stringify({ type: "gift-capsule-host", name: state.profile.name || state.profile.username || "Host", username: state.profile.username || "", avatar: state.profile.avatar || "", _room: room, _via: "ws-state", _serverTs: Date.now() }));
              }
              if (state && Array.isArray(state.seats)) {
                sendWs(socket, JSON.stringify({ type: "remote-seats", seats: state.seats, _room: room, _via: "ws-state", _serverTs: Date.now() }));
              }
            } catch (_) {}
          }
          relayWs(room, socket, JSON.stringify(safe));
        });
      } catch (error) {
        try { socket.write(wsCloseFrame(1009, "Bad frame")); } catch (_) {}
        socket.destroy();
      }
    });
    socket.on("close", () => cleanupWs(socket));
    socket.on("end", () => cleanupWs(socket));
    socket.on("error", () => cleanupWs(socket));
  } catch (error) {
    try { socket.destroy(); } catch (_) {}
  }
});

if (require.main === module) {
  databaseReady.then(() => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`Dubai King Guest Live: http://localhost:${PORT}`);
      console.log(`Phone / LAN: http://<your-mac-ip>:${PORT}`);
      console.log(`MongoDB database: ${MONGODB_DB}`);
      console.log("Secure configuration loaded from environment variables.");
    });
  }).catch((error) => {
    console.error("MongoDB connection failed:", error.message);
    console.error("Start MongoDB locally or put your MongoDB Atlas connection string in .env.");
    process.exit(1);
  });
}

module.exports = server;
