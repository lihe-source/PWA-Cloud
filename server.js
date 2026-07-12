import crypto from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { google } from "googleapis";

const APP_ID = "drivedock";
const APP_VERSION = "1.0.0";
const PORT = Number(process.env.PORT) || 8080;
const HARD_MAX_FILE_BYTES = 524288000;
const MAX_FILE_BYTES = Math.min(
  HARD_MAX_FILE_BYTES,
  Math.max(1, Number(process.env.MAX_FILE_BYTES) || HARD_MAX_FILE_BYTES),
);
const DRIVE_CHUNK_UNIT = 256 * 1024;
const requestedChunkBytes = Number(process.env.UPLOAD_CHUNK_BYTES) || 8388608;
const UPLOAD_CHUNK_BYTES = Math.min(
  64 * 1024 * 1024,
  Math.max(DRIVE_CHUNK_UNIT, Math.floor(requestedChunkBytes / DRIVE_CHUNK_UNIT) * DRIVE_CHUNK_UNIT),
);
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";
const DRIVE_SHARED_DRIVE_ID = process.env.DRIVE_SHARED_DRIVE_ID || "";
const GOOGLE_WEB_CLIENT_ID = process.env.GOOGLE_WEB_CLIENT_ID || "";
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 30 * 24 * 60 * 60;
const SESSION_SAME_SITE = ["lax", "strict", "none"].includes(process.env.SESSION_SAME_SITE)
  ? process.env.SESSION_SAME_SITE
  : process.env.NODE_ENV === "production"
    ? "none"
    : "lax";
const SESSION_CONFIGURED = Boolean(process.env.SESSION_SIGNING_KEY);
const SESSION_SECRET = process.env.SESSION_SIGNING_KEY || crypto.randomBytes(48).toString("base64url");
const SESSION_COOKIE_NAME = process.env.NODE_ENV === "production" ? "__Host-drivedock_session" : "drivedock_session";
const ALLOW_ANONYMOUS_UPLOADS = process.env.ALLOW_ANONYMOUS_UPLOADS !== "false";
const PUBLIC_DOWNLOADS = process.env.PUBLIC_DOWNLOADS !== "false";
const IP_DISPLAY_MODE = process.env.IP_DISPLAY_MODE === "full" ? "full" : "masked";
const TRUSTED_CLIENT_IP_HEADER = (process.env.TRUSTED_CLIENT_IP_HEADER || "").toLowerCase();
const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || "").replace(/\/$/, "");
const ADMIN_GOOGLE_SUBS = new Set(splitCsv(process.env.ADMIN_GOOGLE_SUBS));
const ADMIN_EMAILS = new Set(splitCsv(process.env.ADMIN_EMAILS).map((email) => email.toLowerCase()));
const ALLOWED_ORIGINS = new Set(splitCsv(process.env.ALLOWED_ORIGINS));
const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((request, response, next) => {
  request.requestId = request.get("X-Request-Id")?.slice(0, 100) || crypto.randomUUID();
  response.set("X-Request-Id", request.requestId);
  next();
});
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "no-referrer" },
  }),
);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || isAllowedOrigin(origin)) return callback(null, true);
      return callback(httpError(403, "ORIGIN_NOT_ALLOWED", "此網站來源未獲 API 授權"));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Requested-With", "X-Request-Id"],
    exposedHeaders: ["Content-Disposition", "Content-Length", "X-Request-Id", "Retry-After"],
    maxAge: 86400,
  }),
);
app.use(express.json({ limit: "96kb", strict: true }));
app.use((request, _response, next) => {
  request.user = readSession(request);
  next();
});

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (request) => abuseKey(request),
});
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (request) => abuseKey(request),
  message: { error: { code: "RATE_LIMITED", message: "上傳工作建立過於頻繁，請稍後重試", retryable: true } },
});
app.use("/api", generalLimiter);

let driveClientPromise;
let drivePromise;
const googleIdVerifier = new OAuth2Client(GOOGLE_WEB_CLIENT_ID || undefined);

function splitCsv(value = "") {
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (process.env.NODE_ENV !== "production" && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return true;
  return false;
}

function ensureMutationOrigin(request, _response, next) {
  const origin = request.get("Origin");
  if (!origin || isAllowedOrigin(origin)) return next();
  return next(httpError(403, "ORIGIN_NOT_ALLOWED", "此網站來源未獲 API 授權"));
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function httpError(status, code, message, retryable = false, details) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  error.details = details;
  return error;
}

function sendData(response, data, status = 200) {
  response.status(status).json({ data, requestId: response.req.requestId });
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySignedPayload(value) {
  if (!value || typeof value !== "string") return null;
  const [body, signature] = value.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest();
  let received;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(request) {
  const cookies = {};
  for (const part of String(request.get("Cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function readSession(request) {
  const payload = verifySignedPayload(parseCookies(request)[SESSION_COOKIE_NAME]);
  if (!payload?.sub) return null;
  return {
    sub: String(payload.sub),
    name: String(payload.name || "Google 使用者"),
    picture: String(payload.picture || ""),
    email: String(payload.email || ""),
    emailVerified: Boolean(payload.emailVerified),
  };
}

function setSessionCookie(response, user) {
  const now = Math.floor(Date.now() / 1000);
  const value = signPayload({ ...user, iat: now, exp: now + SESSION_TTL_SECONDS });
  response.cookie(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || SESSION_SAME_SITE === "none",
    sameSite: SESSION_SAME_SITE,
    path: "/",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

function clearSessionCookie(response) {
  response.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || SESSION_SAME_SITE === "none",
    sameSite: SESSION_SAME_SITE,
    path: "/",
  });
}

function isAdmin(user) {
  if (!user) return false;
  if (ADMIN_GOOGLE_SUBS.has(user.sub)) return true;
  return Boolean(user.emailVerified && user.email && ADMIN_EMAILS.has(user.email.toLowerCase()));
}

function requireAdmin(request, _response, next) {
  if (!request.user) return next(httpError(401, "AUTH_REQUIRED", "請先使用 Google 帳戶登入"));
  if (!isAdmin(request.user)) return next(httpError(403, "ADMIN_REQUIRED", "此操作只開放 API 管理員"));
  return next();
}

function stableHash(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(String(value)).digest("base64url").slice(0, 32);
}

function getClientIp(request) {
  if (TRUSTED_CLIENT_IP_HEADER) {
    const trusted = request.get(TRUSTED_CLIENT_IP_HEADER);
    if (trusted) return trusted.trim().slice(0, 80);
  }
  const forwarded = String(request.get("X-Forwarded-For") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (forwarded.length >= 2) return forwarded.at(-2).slice(0, 80);
  return String(request.socket.remoteAddress || "unknown").slice(0, 80);
}

function maskIp(ip) {
  if (IP_DISPLAY_MODE === "full") return ip;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d+$/, ".•••");
  if (ip.includes(":")) {
    const groups = ip.split(":");
    return `${groups.slice(0, 4).join(":")}:••••`;
  }
  return "訪客";
}

function abuseKey(request) {
  return request.user?.sub ? `g:${stableHash(request.user.sub)}` : `ip:${stableHash(getClientIp(request))}`;
}

function truncateUtf8(value, maxBytes = 90) {
  const input = String(value || "");
  if (Buffer.byteLength(input) <= maxBytes) return input;
  let result = "";
  for (const char of input) {
    if (Buffer.byteLength(result + char) > maxBytes - 3) break;
    result += char;
  }
  return `${result}…`;
}

function safeName(value) {
  const name = String(value || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\\/]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) throw httpError(400, "INVALID_FILE_NAME", "檔案名稱不能為空白");
  return [...name].slice(0, 200).join("");
}

function entityForKind(kind) {
  const map = { file: "file", photo: "photo", noteAttachment: "noteAttachment" };
  if (!map[kind]) throw httpError(400, "INVALID_FILE_KIND", "不支援的檔案分類");
  return map[kind];
}

function uploaderProperties(request) {
  if (request.user) {
    return {
      uploaderKind: "google",
      uploaderKey: stableHash(request.user.sub),
      uploaderLabel: truncateUtf8(request.user.name || "Google 使用者", 80),
      guestIpMask: "",
    };
  }
  const ip = getClientIp(request);
  return {
    uploaderKind: "guest",
    uploaderKey: stableHash(ip),
    uploaderLabel: "訪客",
    guestIpMask: truncateUtf8(maskIp(ip), 80),
  };
}

async function createDriveAuthClient() {
  if (
    process.env.DRIVE_OAUTH_CLIENT_ID &&
    process.env.DRIVE_OAUTH_CLIENT_SECRET &&
    process.env.DRIVE_OAUTH_REFRESH_TOKEN
  ) {
    const oauth = new OAuth2Client(process.env.DRIVE_OAUTH_CLIENT_ID, process.env.DRIVE_OAUTH_CLIENT_SECRET);
    oauth.setCredentials({ refresh_token: process.env.DRIVE_OAUTH_REFRESH_TOKEN });
    return oauth;
  }
  if (process.env.DRIVE_SERVICE_ACCOUNT_JSON) {
    let credentials;
    try {
      credentials = JSON.parse(process.env.DRIVE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error("DRIVE_SERVICE_ACCOUNT_JSON 不是有效 JSON");
    }
    const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/drive"] });
    return auth.getClient();
  }
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/drive"] });
  return auth.getClient();
}

function getDriveAuthClient() {
  driveClientPromise ||= createDriveAuthClient();
  return driveClientPromise;
}

async function getDrive() {
  drivePromise ||= getDriveAuthClient().then((auth) => google.drive({ version: "v3", auth }));
  return drivePromise;
}

function assertDriveConfigured() {
  if (!DRIVE_FOLDER_ID) throw httpError(503, "DRIVE_NOT_CONFIGURED", "尚未設定 Google Drive 資料夾");
}

function publicApiOrigin(request) {
  return PUBLIC_API_URL || `${request.protocol}://${request.get("host")}`;
}

function canRename(file, request) {
  return isAdmin(request.user) || Boolean(request.user && file.appProperties?.uploaderKey === stableHash(request.user.sub));
}

function toPublicFile(file, request) {
  const properties = file.appProperties || {};
  const id = String(file.id);
  const origin = publicApiOrigin(request);
  const uploaderType = properties.uploaderKind === "google" ? "google" : "anonymous";
  return {
    id,
    name: file.name,
    extension: file.fileExtension || extensionFromName(file.name),
    mimeType: file.mimeType || "application/octet-stream",
    sizeBytes: Number(file.size || 0),
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    kind: properties.entity,
    uploader: {
      type: uploaderType,
      displayName: uploaderType === "google" ? properties.uploaderLabel || "Google 使用者" : "訪客",
      ipLabel: uploaderType === "anonymous" ? properties.guestIpMask || "訪客" : "",
    },
    permissions: {
      canRename: canRename(file, request),
      canDelete: isAdmin(request.user),
      canCopy: String(file.mimeType || "").startsWith("image/"),
    },
    contentUrl: PUBLIC_DOWNLOADS ? `${origin}/api/files/${encodeURIComponent(id)}/content` : "",
    thumbnailUrl: String(file.mimeType || "").startsWith("image/")
      ? `${origin}/api/files/${encodeURIComponent(id)}/thumbnail`
      : "",
  };
}

function extensionFromName(name = "") {
  const index = String(name).lastIndexOf(".");
  return index > 0 && index < String(name).length - 1 ? String(name).slice(index + 1).toLowerCase() : "—";
}

function isSupportedImagePrefix(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  const head = buffer.subarray(0, 12).toString("ascii");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return true;
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return true;
  if (head.slice(4, 8) === "ftyp") {
    return /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(head.slice(8, 12));
  }
  return false;
}

async function readDriveFilePrefix(fileId) {
  const authClient = await getDriveAuthClient();
  const access = await authClient.getAccessToken();
  const token = typeof access === "string" ? access : access?.token;
  if (!token) throw httpError(502, "DRIVE_AUTH_FAILED", "無法取得 Google Drive 存取憑證", true);
  const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Range: "bytes=0-31" },
  });
  if (!response.ok || !response.body) throw httpError(502, "DRIVE_UPSTREAM_ERROR", "無法驗證圖片內容", true);
  const reader = response.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return Buffer.from(value || []).subarray(0, 32);
}

function driveListParameters(entity, pageSize = 100, pageToken) {
  const q = [
    `'${DRIVE_FOLDER_ID.replace(/'/g, "\\'")}' in parents`,
    "trashed=false",
    `appProperties has { key='appId' and value='${APP_ID}' }`,
    `appProperties has { key='entity' and value='${entity}' }`,
    `appProperties has { key='status' and value='${entity === "note" ? "published" : "ready"}' }`,
  ].join(" and ");
  return {
    q,
    pageSize: Math.min(100, Math.max(1, Number(pageSize) || 100)),
    pageToken: pageToken || undefined,
    orderBy: "createdTime desc",
    fields:
      "nextPageToken,files(id,name,size,fileExtension,mimeType,createdTime,modifiedTime,thumbnailLink,parents,trashed,appProperties)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(DRIVE_SHARED_DRIVE_ID
      ? { corpora: "drive", driveId: DRIVE_SHARED_DRIVE_ID }
      : { corpora: "user" }),
  };
}

async function getManagedFile(fileId, { ready = true } = {}) {
  assertDriveConfigured();
  const drive = await getDrive();
  let result;
  try {
    result = await drive.files.get({
      fileId,
      supportsAllDrives: true,
      fields: "id,name,size,fileExtension,mimeType,createdTime,modifiedTime,thumbnailLink,parents,trashed,appProperties",
    });
  } catch (error) {
    if (error.code === 404) throw httpError(404, "FILE_NOT_FOUND", "找不到檔案");
    throw error;
  }
  const file = result.data;
  const managed = file.appProperties?.appId === APP_ID && file.parents?.includes(DRIVE_FOLDER_ID) && !file.trashed;
  const readableStatuses = new Set(["ready", "published", "attached"]);
  if (!managed || (ready && !readableStatuses.has(file.appProperties?.status))) {
    throw httpError(404, "FILE_NOT_FOUND", "找不到檔案");
  }
  return file;
}

function driveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function listAllManagedWithQuery(extraQuery, maxItems = 5000) {
  assertDriveConfigured();
  const drive = await getDrive();
  const files = [];
  let pageToken;
  const baseQuery = [
    `'${driveQueryValue(DRIVE_FOLDER_ID)}' in parents`,
    "trashed=false",
    `appProperties has { key='appId' and value='${APP_ID}' }`,
    extraQuery,
  ]
    .filter(Boolean)
    .join(" and ");
  do {
    const result = await drive.files.list({
      q: baseQuery,
      pageSize: Math.min(1000, maxItems - files.length),
      pageToken,
      fields:
        "nextPageToken,files(id,name,size,fileExtension,mimeType,createdTime,modifiedTime,parents,trashed,appProperties)",
      spaces: "drive",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(DRIVE_SHARED_DRIVE_ID
        ? { corpora: "drive", driveId: DRIVE_SHARED_DRIVE_ID }
        : { corpora: "user" }),
    });
    files.push(...(result.data.files || []));
    pageToken = result.data.nextPageToken || undefined;
  } while (pageToken && files.length < maxItems);
  return files.slice(0, maxItems);
}

async function adminStorageCandidates() {
  const [pending, readyAttachments, attachedAttachments, publishedNotes] = await Promise.all([
    listAllManagedWithQuery("appProperties has { key='status' and value='pending' }"),
    listAllManagedWithQuery(
      "appProperties has { key='entity' and value='noteAttachment' } and appProperties has { key='status' and value='ready' }",
    ),
    listAllManagedWithQuery(
      "appProperties has { key='entity' and value='noteAttachment' } and appProperties has { key='status' and value='attached' }",
    ),
    listAllManagedWithQuery(
      "appProperties has { key='entity' and value='note' } and appProperties has { key='status' and value='published' }",
    ),
  ]);
  const activeNoteIds = new Set(publishedNotes.map((file) => file.appProperties?.noteId).filter(Boolean));
  const orphanAttachments = [...readyAttachments, ...attachedAttachments].filter(
    (file) => !file.appProperties?.noteId || !activeNoteIds.has(file.appProperties.noteId),
  );
  const unique = new Map();
  [...pending, ...orphanAttachments].forEach((file) => unique.set(file.id, file));
  return [...unique.values()];
}

app.get("/api/health", (_request, response) => {
  sendData(response, {
    ok: true,
    version: APP_VERSION,
    driveConfigured: Boolean(DRIVE_FOLDER_ID),
    sessionConfigured: SESSION_CONFIGURED,
  });
});

app.get("/api/config", (request, response) => {
  sendData(response, {
    version: APP_VERSION,
    apiReady: true,
    driveConfigured: Boolean(DRIVE_FOLDER_ID),
    storageMode: DRIVE_SHARED_DRIVE_ID
      ? "Google Shared Drive + Cloud Run ADC"
      : process.env.DRIVE_OAUTH_REFRESH_TOKEN
        ? "Google Drive 擁有者 OAuth"
        : "Google Drive（待確認身分模式）",
    maxFileBytes: MAX_FILE_BYTES,
    uploadChunkBytes: UPLOAD_CHUNK_BYTES,
    anonymousUploads: ALLOW_ANONYMOUS_UPLOADS,
    publicDownloads: PUBLIC_DOWNLOADS,
    ipDisplayMode: IP_DISPLAY_MODE,
    canManage: isAdmin(request.user),
  });
});

app.post(
  "/api/auth/google",
  ensureMutationOrigin,
  asyncRoute(async (request, response) => {
    if (!GOOGLE_WEB_CLIENT_ID) throw httpError(503, "GOOGLE_LOGIN_NOT_CONFIGURED", "尚未設定 Google Web Client ID");
    const credential = String(request.body?.credential || "");
    if (!credential || credential.length > 10000) throw httpError(400, "INVALID_GOOGLE_TOKEN", "缺少 Google 登入憑證");
    let ticket;
    try {
      ticket = await googleIdVerifier.verifyIdToken({ idToken: credential, audience: GOOGLE_WEB_CLIENT_ID });
    } catch {
      throw httpError(401, "INVALID_GOOGLE_TOKEN", "Google 登入憑證無效或已過期");
    }
    const payload = ticket.getPayload();
    if (!payload?.sub) throw httpError(401, "INVALID_GOOGLE_TOKEN", "Google 登入憑證缺少使用者識別碼");
    const user = {
      sub: payload.sub,
      name: truncateUtf8(payload.name || "Google 使用者", 100),
      picture: String(payload.picture || "").slice(0, 1000),
      email: String(payload.email || "").slice(0, 320),
      emailVerified: Boolean(payload.email_verified),
    };
    setSessionCookie(response, user);
    sendData(response, {
      authenticated: true,
      user: { name: user.name, picture: user.picture },
      role: isAdmin(user) ? "admin" : "user",
      canManage: isAdmin(user),
    });
  }),
);

app.get("/api/auth/session", (request, response) => {
  if (!request.user) return sendData(response, { authenticated: false, user: null, role: "guest", canManage: false });
  setSessionCookie(response, request.user);
  return sendData(response, {
    authenticated: true,
    user: { name: request.user.name, picture: request.user.picture },
    role: isAdmin(request.user) ? "admin" : "user",
    canManage: isAdmin(request.user),
  });
});

app.post("/api/auth/logout", ensureMutationOrigin, (_request, response) => {
  clearSessionCookie(response);
  sendData(response, { authenticated: false });
});

app.get(
  "/api/files",
  asyncRoute(async (request, response) => {
    assertDriveConfigured();
    const entity = entityForKind(String(request.query.kind || "file"));
    if (entity === "noteAttachment") throw httpError(403, "ATTACHMENT_LIST_FORBIDDEN", "附件不能公開列出");
    const drive = await getDrive();
    const result = await drive.files.list(driveListParameters(entity, request.query.pageSize, request.query.pageToken));
    sendData(response, {
      files: (result.data.files || []).map((file) => toPublicFile(file, request)),
      nextPageToken: result.data.nextPageToken || null,
      canManage: isAdmin(request.user),
    });
  }),
);

app.post(
  "/api/uploads/session",
  uploadLimiter,
  ensureMutationOrigin,
  asyncRoute(async (request, response) => {
    assertDriveConfigured();
    if (!request.user && !ALLOW_ANONYMOUS_UPLOADS) throw httpError(401, "AUTH_REQUIRED", "此網站只允許登入使用者上傳");
    const name = safeName(request.body?.name);
    const sizeBytes = Number(request.body?.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      throw httpError(400, "INVALID_FILE_SIZE", "檔案大小必須大於 0 bytes");
    }
    if (sizeBytes > MAX_FILE_BYTES) {
      throw httpError(413, "FILE_TOO_LARGE", `單一檔案不得超過 ${MAX_FILE_BYTES} bytes`, false, {
        maxBytes: MAX_FILE_BYTES,
      });
    }
    const entity = entityForKind(String(request.body?.kind || "file"));
    const mimeType = truncateUtf8(request.body?.mimeType || "application/octet-stream", 100);
    const photoMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif", "image/avif"]);
    if (entity === "photo" && !photoMimeTypes.has(mimeType.toLowerCase())) {
      throw httpError(415, "UNSUPPORTED_MEDIA_TYPE", "相片圖庫只接受圖片檔案");
    }
    const noteId = entity === "noteAttachment" ? String(request.body?.noteId || "").slice(0, 80) : "";
    if (entity === "noteAttachment" && !noteId) throw httpError(400, "NOTE_ID_REQUIRED", "備註附件缺少 noteId");

    const drive = await getDrive();
    const generated = await drive.files.generateIds({ count: 1, space: "drive", type: "files" });
    const fileId = generated.data.ids?.[0];
    if (!fileId) throw httpError(502, "DRIVE_UPSTREAM_ERROR", "Google Drive 未產生檔案識別碼", true);
    const uploadId = crypto.randomUUID();
    const properties = {
      appId: APP_ID,
      schema: "1",
      entity,
      status: "pending",
      uploadId,
      expectedBytes: String(sizeBytes),
      ...uploaderProperties(request),
      ...(noteId ? { noteId } : {}),
    };
    const metadata = {
      id: fileId,
      name,
      parents: [DRIVE_FOLDER_ID],
      mimeType,
      appProperties: properties,
    };
    const authClient = await getDriveAuthClient();
    const access = await authClient.getAccessToken();
    const token = typeof access === "string" ? access : access?.token;
    if (!token) throw httpError(502, "DRIVE_AUTH_FAILED", "無法取得 Google Drive 存取憑證", true);
    const uploadEndpoint = new URL("https://www.googleapis.com/upload/drive/v3/files");
    uploadEndpoint.searchParams.set("uploadType", "resumable");
    uploadEndpoint.searchParams.set("supportsAllDrives", "true");
    uploadEndpoint.searchParams.set(
      "fields",
      "id,name,size,fileExtension,mimeType,createdTime,modifiedTime,parents,appProperties",
    );
    const upstream = await fetch(uploadEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(sizeBytes),
      },
      body: JSON.stringify(metadata),
    });
    const uploadUrl = upstream.headers.get("location");
    if (!upstream.ok || !uploadUrl) {
      const message = truncateUtf8(await upstream.text(), 300);
      throw httpError(502, "DRIVE_SESSION_FAILED", `Google Drive 無法建立上傳工作：${message || upstream.status}`, true);
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const finalizeExpiresSeconds = nowSeconds + 7 * 24 * 60 * 60;
    const finalizeToken = signPayload({ purpose: "finalize", uploadId, fileId, exp: finalizeExpiresSeconds });
    response.set("Cache-Control", "no-store");
    sendData(
      response,
      {
        session: {
          uploadId,
          fileId,
          uploadUrl,
          chunkSizeBytes: UPLOAD_CHUNK_BYTES,
          expiresAt: new Date(finalizeExpiresSeconds * 1000).toISOString(),
          finalizeToken,
        },
      },
      201,
    );
  }),
);

app.post(
  "/api/uploads/:uploadId/finalize",
  ensureMutationOrigin,
  asyncRoute(async (request, response) => {
    const uploadId = String(request.params.uploadId);
    const fileId = String(request.body?.fileId || "");
    const capability = verifySignedPayload(request.body?.finalizeToken);
    if (
      !capability ||
      capability.purpose !== "finalize" ||
      capability.uploadId !== uploadId ||
      capability.fileId !== fileId
    ) {
      throw httpError(403, "INVALID_FINALIZE_TOKEN", "上傳完成憑證無效或已過期");
    }
    const file = await getManagedFile(fileId, { ready: false });
    const properties = file.appProperties || {};
    if (properties.uploadId !== uploadId) throw httpError(422, "UPLOAD_ID_MISMATCH", "檔案與上傳工作不相符");
    if (properties.status === "ready") return sendData(response, { file: toPublicFile(file, request), idempotent: true });
    if (Number(file.size || 0) !== Number(properties.expectedBytes)) {
      const drive = await getDrive();
      await drive.files.update({ fileId, supportsAllDrives: true, requestBody: { trashed: true } });
      throw httpError(422, "SIZE_MISMATCH", "Drive 寫入大小與原始檔案不相符");
    }
    const drive = await getDrive();
    if (properties.entity === "photo") {
      const prefix = await readDriveFilePrefix(fileId);
      if (!isSupportedImagePrefix(prefix)) {
        await drive.files.update({ fileId, supportsAllDrives: true, requestBody: { trashed: true } });
        throw httpError(415, "INVALID_IMAGE", "圖片內容與支援格式不相符");
      }
    }
    const updated = await drive.files.update({
      fileId,
      supportsAllDrives: true,
      requestBody: { appProperties: { ...properties, status: "ready" } },
      fields: "id,name,size,fileExtension,mimeType,createdTime,modifiedTime,parents,appProperties",
    });
    sendData(response, { file: toPublicFile(updated.data, request) });
  }),
);

app.patch(
  "/api/files/:fileId",
  ensureMutationOrigin,
  asyncRoute(async (request, response) => {
    const file = await getManagedFile(request.params.fileId);
    if (!canRename(file, request)) {
      if (!request.user) throw httpError(401, "AUTH_REQUIRED", "請先使用原上傳 Google 帳戶登入");
      throw httpError(403, "EDIT_FORBIDDEN", "只有檔案上傳者或管理員可以重新命名");
    }
    let name = safeName(request.body?.name);
    if (request.body?.preserveExtension) {
      const currentExtension = extensionFromName(file.name);
      if (currentExtension !== "—" && extensionFromName(name) !== currentExtension) name = `${name}.${currentExtension}`;
    }
    const drive = await getDrive();
    const updated = await drive.files.update({
      fileId: file.id,
      supportsAllDrives: true,
      requestBody: { name },
      fields: "id,name,size,fileExtension,mimeType,createdTime,modifiedTime,parents,appProperties",
    });
    sendData(response, { file: toPublicFile(updated.data, request) });
  }),
);

app.post(
  "/api/files/batch-trash",
  ensureMutationOrigin,
  requireAdmin,
  asyncRoute(async (request, response) => {
    const ids = [...new Set(Array.isArray(request.body?.ids) ? request.body.ids.map(String) : [])].slice(0, 100);
    if (!ids.length) throw httpError(400, "FILE_IDS_REQUIRED", "請至少選擇一個檔案");
    const drive = await getDrive();
    const results = [];
    for (let index = 0; index < ids.length; index += 5) {
      const batch = ids.slice(index, index + 5);
      const settled = await Promise.allSettled(
        batch.map(async (id) => {
          const file = await getManagedFile(id, { ready: false });
          await drive.files.update({ fileId: file.id, supportsAllDrives: true, requestBody: { trashed: true } });
          return { id, success: true };
        }),
      );
      settled.forEach((result, offset) => {
        const id = batch[offset];
        results.push(
          result.status === "fulfilled"
            ? result.value
            : { id, success: false, error: result.reason?.code || "DRIVE_UPSTREAM_ERROR" },
        );
      });
    }
    const hasFailure = results.some((item) => !item.success);
    sendData(response, { results }, hasFailure ? 207 : 200);
  }),
);

app.get(
  "/api/admin/storage",
  requireAdmin,
  asyncRoute(async (_request, response) => {
    const candidates = await adminStorageCandidates();
    sendData(response, {
      candidates: candidates.map((file) => ({
        id: file.id,
        name: file.name,
        sizeBytes: Number(file.size || 0),
        createdTime: file.createdTime,
        entity: file.appProperties?.entity || "unknown",
        status: file.appProperties?.status || "unknown",
        reason:
          file.appProperties?.status === "pending" ? "unfinished-upload" : "orphan-note-attachment",
      })),
      totalBytes: candidates.reduce((sum, file) => sum + Number(file.size || 0), 0),
    });
  }),
);

app.post(
  "/api/admin/storage/cleanup",
  ensureMutationOrigin,
  requireAdmin,
  asyncRoute(async (request, response) => {
    const candidates = await adminStorageCandidates();
    const requestedIds = new Set(
      (Array.isArray(request.body?.ids) ? request.body.ids : []).map(String).slice(0, 100),
    );
    const olderThanHours = Math.min(24 * 30, Math.max(1, Number(request.body?.olderThanHours) || 24 * 7));
    const cutoff = Date.now() - olderThanHours * 60 * 60 * 1000;
    const selected = candidates.filter((file) =>
      requestedIds.size
        ? requestedIds.has(file.id)
        : new Date(file.createdTime || 0).getTime() < cutoff,
    );
    const drive = await getDrive();
    const results = [];
    for (let index = 0; index < selected.length; index += 5) {
      const batch = selected.slice(index, index + 5);
      const settled = await Promise.allSettled(
        batch.map((file) =>
          drive.files.update({ fileId: file.id, supportsAllDrives: true, requestBody: { trashed: true } }),
        ),
      );
      settled.forEach((result, offset) => {
        results.push({
          id: batch[offset].id,
          success: result.status === "fulfilled",
          ...(result.status === "rejected" ? { error: result.reason?.code || "DRIVE_UPSTREAM_ERROR" } : {}),
        });
      });
    }
    const hasFailure = results.some((item) => !item.success);
    sendData(response, { olderThanHours, results }, hasFailure ? 207 : 200);
  }),
);

app.get(
  "/api/files/:fileId/content",
  asyncRoute(async (request, response) => {
    if (!PUBLIC_DOWNLOADS) throw httpError(403, "DOWNLOADS_DISABLED", "此網站未開放下載");
    const file = await getManagedFile(request.params.fileId);
    const drive = await getDrive();
    const upstream = await drive.files.get(
      { fileId: file.id, alt: "media", supportsAllDrives: true },
      { responseType: "stream" },
    );
    response.set("Content-Type", file.mimeType || "application/octet-stream");
    if (file.size) response.set("Content-Length", String(file.size));
    response.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    response.set("Cache-Control", "private, max-age=0, no-store");
    upstream.data.on("error", (error) => response.destroy(error));
    upstream.data.pipe(response);
  }),
);

app.get(
  "/api/files/:fileId/thumbnail",
  asyncRoute(async (request, response) => {
    const file = await getManagedFile(request.params.fileId);
    if (!String(file.mimeType || "").startsWith("image/") || file.mimeType === "image/svg+xml") {
      throw httpError(415, "UNSUPPORTED_MEDIA_TYPE", "此檔案沒有可安全顯示的縮圖");
    }
    if (file.thumbnailLink) {
      try {
        const thumbnailUrl = file.thumbnailLink.replace(/=s\d+$/, "=s800");
        const authClient = await getDriveAuthClient();
        const access = await authClient.getAccessToken();
        const token = typeof access === "string" ? access : access?.token;
        const thumbnail = await fetch(thumbnailUrl, {
          headers: { Accept: "image/*", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        });
        if (thumbnail.ok && thumbnail.body) {
          response.set("Content-Type", thumbnail.headers.get("content-type") || file.mimeType);
          response.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`);
          response.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
          Readable.fromWeb(thumbnail.body).pipe(response);
          return;
        }
      } catch {
        // Fall back to streaming the original image when Drive thumbnail retrieval fails.
      }
    }
    response.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    response.sendFile(path.join(ROOT_DIR, "icon-512.png"));
  }),
);

async function validateNoteAttachments(ids, request, expectedNoteId = "", allowReassign = false) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 20);
  const attachments = [];
  for (const id of uniqueIds) {
    const file = await getManagedFile(id);
    const properties = file.appProperties || {};
    if (properties.entity !== "noteAttachment") throw httpError(422, "INVALID_ATTACHMENT", "附件分類不正確");
    const owner = request.user && properties.uploaderKey === stableHash(request.user.sub);
    if (!isAdmin(request.user) && !owner && properties.noteId !== expectedNoteId) {
      throw httpError(403, "ATTACHMENT_FORBIDDEN", "不能引用其他使用者的附件");
    }
    if (expectedNoteId && properties.noteId !== expectedNoteId && !allowReassign) {
      throw httpError(422, "ATTACHMENT_NOTE_MISMATCH", "附件不屬於這則備註草稿");
    }
    attachments.push(file);
  }
  return attachments;
}

function noteAttachmentSummary(file, request) {
  const origin = publicApiOrigin(request);
  return {
    id: file.id,
    name: file.name,
    sizeBytes: Number(file.sizeBytes ?? file.size ?? 0),
    mimeType: file.mimeType,
    contentUrl: PUBLIC_DOWNLOADS ? `${origin}/api/files/${encodeURIComponent(file.id)}/content` : "",
  };
}

function noteAttachmentJson(file) {
  return {
    id: file.id,
    name: file.name,
    sizeBytes: Number(file.size || 0),
    mimeType: file.mimeType || "application/octet-stream",
  };
}

function notePublicRecord(metadata, content, request, attachmentFiles = []) {
  const properties = metadata.appProperties || {};
  const uploaderType = properties.uploaderKind === "google" ? "google" : "anonymous";
  const owner = request.user && properties.uploaderKey === stableHash(request.user.sub);
  return {
    id: metadata.id,
    title: content.title || metadata.name,
    content: content.content || "",
    createdTime: metadata.createdTime,
    modifiedTime: metadata.modifiedTime,
    uploader: {
      type: uploaderType,
      displayName: uploaderType === "google" ? properties.uploaderLabel || "Google 使用者" : "訪客",
      ipLabel: uploaderType === "anonymous" ? properties.guestIpMask || "訪客" : "",
    },
    attachments: attachmentFiles.map((file) => noteAttachmentSummary(file, request)),
    permissions: { canEdit: Boolean(isAdmin(request.user) || owner), canDelete: isAdmin(request.user) },
  };
}

async function readNoteContent(drive, fileId) {
  const media = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "text" },
  );
  if (typeof media.data === "object") return media.data;
  try {
    return JSON.parse(String(media.data || "{}"));
  } catch {
    return {};
  }
}

async function mapInBatches(items, batchSize, mapper) {
  const results = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    results.push(...(await Promise.all(batch.map(mapper))));
  }
  return results;
}

app.get(
  "/api/notes",
  asyncRoute(async (request, response) => {
    assertDriveConfigured();
    const drive = await getDrive();
    const result = await drive.files.list(driveListParameters("note", request.query.pageSize, request.query.pageToken));
    const notes = await mapInBatches(result.data.files || [], 5, async (metadata) => {
      try {
        const content = await readNoteContent(drive, metadata.id);
        let attachmentFiles = Array.isArray(content.attachments) ? content.attachments.slice(0, 20) : [];
        if (!attachmentFiles.length && Array.isArray(content.attachmentIds)) {
          const legacy = await Promise.allSettled(
            content.attachmentIds.slice(0, 20).map((id) => getManagedFile(String(id))),
          );
          attachmentFiles = legacy.filter((entry) => entry.status === "fulfilled").map((entry) => entry.value);
        }
        return notePublicRecord(metadata, content, request, attachmentFiles);
      } catch {
        // Ignore malformed note JSON; administrators can inspect it in Drive.
        return null;
      }
    });
    sendData(response, {
      notes: notes.filter(Boolean),
      nextPageToken: result.data.nextPageToken || null,
      canManage: isAdmin(request.user),
    });
  }),
);

app.post(
  "/api/notes",
  uploadLimiter,
  ensureMutationOrigin,
  asyncRoute(async (request, response) => {
    assertDriveConfigured();
    if (!request.user && !ALLOW_ANONYMOUS_UPLOADS) throw httpError(401, "AUTH_REQUIRED", "此網站只允許登入使用者新增備註");
    const title = safeName(request.body?.title);
    const content = String(request.body?.content || "").trim().slice(0, 20000);
    const draftId = String(request.body?.draftId || "").slice(0, 80);
    if (!content) throw httpError(400, "NOTE_CONTENT_REQUIRED", "備註內容不能為空白");
    if (!draftId) throw httpError(400, "NOTE_DRAFT_ID_REQUIRED", "備註缺少草稿識別碼");
    const attachments = await validateNoteAttachments(request.body?.attachmentIds, request, draftId, false);
    const drive = await getDrive();
    const attachmentJson = attachments.map(noteAttachmentJson);
    const body = JSON.stringify({
      schema: 1,
      title,
      content,
      attachmentIds: attachmentJson.map((file) => file.id),
      attachments: attachmentJson,
    });
    const created = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: title,
        parents: [DRIVE_FOLDER_ID],
        mimeType: "application/json",
        appProperties: {
          appId: APP_ID,
          schema: "1",
          entity: "note",
          status: "published",
          noteId: draftId,
          ...uploaderProperties(request),
        },
      },
      media: { mimeType: "application/json", body: Readable.from([body]) },
      fields: "id,name,size,fileExtension,mimeType,createdTime,modifiedTime,parents,appProperties",
    });
    await Promise.allSettled(
      attachments.map((attachment) =>
        drive.files.update({
          fileId: attachment.id,
          supportsAllDrives: true,
          requestBody: { appProperties: { ...attachment.appProperties, status: "attached", noteId: draftId } },
        }),
      ),
    );
    sendData(response, { note: notePublicRecord(created.data, { title, content }, request, attachments) }, 201);
  }),
);

app.patch(
  "/api/notes/:noteId",
  ensureMutationOrigin,
  asyncRoute(async (request, response) => {
    const note = await getManagedFile(request.params.noteId);
    if (note.appProperties?.entity !== "note") throw httpError(404, "NOTE_NOT_FOUND", "找不到備註");
    const owner = request.user && note.appProperties?.uploaderKey === stableHash(request.user.sub);
    if (!owner && !isAdmin(request.user)) {
      if (!request.user) throw httpError(401, "AUTH_REQUIRED", "請先使用原上傳 Google 帳戶登入");
      throw httpError(403, "EDIT_FORBIDDEN", "只有備註作者或管理員可以編輯");
    }
    const title = safeName(request.body?.title);
    const content = String(request.body?.content || "").trim().slice(0, 20000);
    if (!content) throw httpError(400, "NOTE_CONTENT_REQUIRED", "備註內容不能為空白");
    const drive = await getDrive();
    const previousContent = await readNoteContent(drive, note.id);
    const previousAttachmentIds = new Set(
      (Array.isArray(previousContent.attachmentIds) ? previousContent.attachmentIds : []).map(String),
    );
    const attachments = await validateNoteAttachments(request.body?.attachmentIds, request, note.appProperties.noteId, true);
    const nextAttachmentIds = new Set(attachments.map((attachment) => attachment.id));
    for (const attachment of attachments) {
      if (
        attachment.appProperties?.noteId !== note.appProperties.noteId ||
        attachment.appProperties?.status !== "attached"
      ) {
        await drive.files.update({
          fileId: attachment.id,
          supportsAllDrives: true,
          requestBody: {
            appProperties: { ...attachment.appProperties, status: "attached", noteId: note.appProperties.noteId },
          },
        });
      }
    }
    const attachmentJson = attachments.map(noteAttachmentJson);
    const body = JSON.stringify({
      schema: 1,
      title,
      content,
      attachmentIds: attachmentJson.map((file) => file.id),
      attachments: attachmentJson,
    });
    const updated = await drive.files.update({
      fileId: note.id,
      supportsAllDrives: true,
      requestBody: { name: title },
      media: { mimeType: "application/json", body: Readable.from([body]) },
      fields: "id,name,size,fileExtension,mimeType,createdTime,modifiedTime,parents,appProperties",
    });
    const removedAttachmentIds = [...previousAttachmentIds].filter((id) => !nextAttachmentIds.has(id));
    await Promise.allSettled(
      removedAttachmentIds.map(async (id) => {
        try {
          const removed = await getManagedFile(id);
          if (
            removed.appProperties?.entity !== "noteAttachment" ||
            removed.appProperties?.noteId !== note.appProperties.noteId
          ) {
            return;
          }
          try {
            await drive.files.update({ fileId: id, supportsAllDrives: true, requestBody: { trashed: true } });
          } catch {
            await drive.files.update({
              fileId: id,
              supportsAllDrives: true,
              requestBody: {
                appProperties: {
                  ...removed.appProperties,
                  status: "ready",
                  noteId: `detached-${note.id}`.slice(0, 100),
                },
              },
            });
          }
        } catch {
          // A missing or already removed attachment needs no further action.
        }
      }),
    );
    sendData(response, { note: notePublicRecord(updated.data, { title, content }, request, attachments) });
  }),
);

const FRONTEND_FILES = new Set([
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "sw.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
]);

app.get(["/", "/index.html"], (_request, response) => response.sendFile(path.join(ROOT_DIR, "index.html")));
app.get("/:asset", (request, response, next) => {
  if (!FRONTEND_FILES.has(request.params.asset)) return next();
  return response.sendFile(path.join(ROOT_DIR, request.params.asset));
});

app.use((request, _response, next) => {
  next(httpError(404, "NOT_FOUND", `找不到路徑 ${request.path}`));
});

app.use((error, request, response, _next) => {
  const googleStatus = Number(error?.response?.status || error?.code);
  let status = Number(error.status) || (googleStatus >= 400 && googleStatus < 600 ? googleStatus : 500);
  let code = error.code && typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
  let message = error.message || "伺服器發生未預期錯誤";
  let retryable = Boolean(error.retryable || status === 429 || status >= 500);
  if (status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(JSON.stringify(error?.response?.data || ""))) {
    status = 429;
    code = "DRIVE_RATE_LIMITED";
    message = "Google Drive 暫時達到用量限制，請稍後重試";
    retryable = true;
  } else if (status >= 500 && code === "INTERNAL_ERROR") {
    code = "DRIVE_UPSTREAM_ERROR";
    message = process.env.NODE_ENV === "production" ? "Google Drive 或伺服器暫時無法完成請求" : message;
  }
  if (status >= 500) {
    console.error(JSON.stringify({ requestId: request.requestId, code, status, message: error.message }));
  }
  response.status(status).json({
    error: { code, message, retryable, ...(error.details ? { details: error.details } : {}) },
    requestId: request.requestId,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`DriveDock API listening on ${PORT}`);
  if (!DRIVE_FOLDER_ID) console.warn("DRIVE_FOLDER_ID is not configured; API storage routes will return 503.");
  if (!SESSION_CONFIGURED) console.warn("SESSION_SIGNING_KEY is not configured; sessions will reset between instances.");
});
