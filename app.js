const baseConfig = window.DRIVEDOCK_CONFIG || {};

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const DIRECT_SETTINGS_KEY = "drivedock_direct_settings";
const savedDirectSettings = readLocalJson(DIRECT_SETTINGS_KEY, {});
const CONFIG = Object.freeze({
  ...baseConfig,
  GOOGLE_CLIENT_ID: String(savedDirectSettings.GOOGLE_CLIENT_ID || baseConfig.GOOGLE_CLIENT_ID || "").trim(),
  DRIVE_FOLDER_ID: String(savedDirectSettings.DRIVE_FOLDER_ID || baseConfig.DRIVE_FOLDER_ID || "").trim(),
  DRIVE_FOLDER_NAME: String(savedDirectSettings.DRIVE_FOLDER_NAME || baseConfig.DRIVE_FOLDER_NAME || "").trim(),
  MAX_FILE_BYTES: Number(baseConfig.MAX_FILE_BYTES) || 524288000,
  UPLOAD_CHUNK_BYTES: Number(baseConfig.UPLOAD_CHUNK_BYTES) || 8388608,
});
const DEMO_MODE = false;
const APP_ID = "drivedock";
const APP_VERSION = String(CONFIG.VERSION || "1.4.0");
const APP_BUILD_DATE = String(CONFIG.BUILD_DATE || "2026-07-13");
const APP_CACHE_NAME = String(CONFIG.CACHE_NAME || `drivedock-v${APP_VERSION}`);
const VERSION_MANIFEST_URL = "./version.json";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_OAUTH_SCOPE = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive",
].join(" ");
const PHOTO_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
]);
const DRIVE_FILE_FIELDS = [
  "id",
  "name",
  "size",
  "fileExtension",
  "mimeType",
  "createdTime",
  "modifiedTime",
  "thumbnailLink",
  "webViewLink",
  "webContentLink",
  "parents",
  "trashed",
  "driveId",
  "appProperties",
  "capabilities(canEdit,canRename,canTrash,canDownload)",
  "owners(displayName,emailAddress)",
  "lastModifyingUser(displayName,emailAddress)",
].join(",");

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes, digits = 2) {
  const value = Number(bytes) || 0;
  if (value === 0) return "0 MB";
  const mb = value / 1024 / 1024;
  if (mb < 0.01) return `${(value / 1024).toFixed(1)} KB`;
  return `${mb.toFixed(digits)} MB`;
}

function formatDate(value, withTime = true) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

function normalizeVersion(value = "0.0.0") {
  return String(value)
    .trim()
    .replace(/^v/i, "")
    .split(".")
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function formatVersion(value = APP_VERSION) {
  return `V${String(value).replace(/^v/i, "")}`;
}

function formatCheckTime(value) {
  if (!value) return "尚未檢查";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未檢查";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function extensionOf(name = "") {
  const clean = String(name).trim();
  const index = clean.lastIndexOf(".");
  if (index <= 0 || index === clean.length - 1) return "—";
  return clean.slice(index + 1).toLowerCase();
}

function initials(name = "?") {
  const trimmed = String(name).trim();
  return trimmed ? [...trimmed][0].toUpperCase() : "?";
}

function normalizeGoogleClientId(value = "") {
  return String(value).trim();
}

function isValidGoogleClientId(value = "") {
  return /^\d+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i.test(normalizeGoogleClientId(value));
}

function normalizeFolderInput(value = "") {
  return String(value).trim().normalize("NFC");
}

function extractFolderId(value = "") {
  const input = normalizeFolderInput(value);
  if (!input) return "";
  if (/^[a-z0-9_-]{10,200}$/i.test(input)) return input;
  try {
    const url = new URL(input);
    const pathMatch = url.pathname.match(/\/folders\/([a-z0-9_-]{10,200})/i);
    if (pathMatch) return pathMatch[1];
    const id = url.searchParams.get("id") || "";
    return /^[a-z0-9_-]{10,200}$/i.test(id) ? id : "";
  } catch {
    return "";
  }
}

function maskDriveId(value = "") {
  const id = String(value).trim();
  if (!id) return "";
  if (id.length <= 10) return `${id.slice(0, 3)}•••${id.slice(-2)}`;
  return `${id.slice(0, 6)}••••${id.slice(-4)}`;
}

function safeDriveFolderLink(value = "", folderId = "") {
  const candidate = String(value).trim();
  if (candidate) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && url.hostname.toLowerCase() === "drive.google.com") return url.href;
    } catch {
      // Fall through to the verified folder ID.
    }
  }
  const id = String(folderId).trim();
  return /^[a-z0-9_-]{10,}$/i.test(id) ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : "";
}

function isFormTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function normalizeRecord(raw, kind = "file") {
  const uploader = raw.uploader || {};
  const id = String(raw.id || raw.driveFileId || uid());
  const mimeType = raw.mimeType || "application/octet-stream";
  const normalizedKind = raw.kind || kind;
  return {
    id,
    name: raw.name || "未命名檔案",
    extension: raw.extension || raw.fileExtension || extensionOf(raw.name),
    mimeType,
    sizeBytes: Number(raw.sizeBytes ?? raw.size ?? 0),
    createdTime: raw.createdTime || raw.createdAt || new Date().toISOString(),
    modifiedTime: raw.modifiedTime || raw.modifiedAt || raw.createdTime || new Date().toISOString(),
    kind: normalizedKind,
    uploader: {
      type: uploader.type || raw.uploaderType || "google",
      displayName: uploader.displayName || raw.uploaderName || raw.uploaderLabel || "Google 使用者",
      ipLabel: uploader.ipLabel || raw.uploaderIp || "—",
    },
    permissions: {
      canRename: Boolean(raw.permissions?.canRename ?? raw.canRename),
      canDelete: Boolean(raw.permissions?.canDelete ?? raw.canDelete),
      canCopy: raw.permissions?.canCopy !== false,
    },
    contentUrl: raw.contentUrl || raw.webViewLink || "",
    thumbnailUrl: raw.thumbnailUrl || "",
    webViewLink: raw.webViewLink || raw.contentUrl || "",
    driveId: raw.driveId || "",
  };
}

function directSettings() {
  const raw = readLocalJson(DIRECT_SETTINGS_KEY, {});
  return {
    googleClientId: normalizeGoogleClientId(raw.GOOGLE_CLIENT_ID || CONFIG.GOOGLE_CLIENT_ID),
    folderInput: normalizeFolderInput(raw.FOLDER_INPUT || raw.DRIVE_FOLDER_ID || CONFIG.DRIVE_FOLDER_ID),
    folderId: String(raw.DRIVE_FOLDER_ID || CONFIG.DRIVE_FOLDER_ID || "").trim(),
    folderName: String(raw.DRIVE_FOLDER_NAME || CONFIG.DRIVE_FOLDER_NAME || "").trim(),
  };
}

function saveDirectSettings(values = {}) {
  const current = directSettings();
  const next = {
    GOOGLE_CLIENT_ID: normalizeGoogleClientId(values.googleClientId ?? current.googleClientId),
    FOLDER_INPUT: normalizeFolderInput(values.folderInput ?? current.folderInput),
    DRIVE_FOLDER_ID: String(values.folderId ?? current.folderId).trim(),
    DRIVE_FOLDER_NAME: String(values.folderName ?? current.folderName).trim(),
  };
  localStorage.setItem(DIRECT_SETTINGS_KEY, JSON.stringify(next));
  return next;
}

function currentFolderId() {
  return String(state?.adminSettings?.folderId || directSettings().folderId || "").trim();
}

function hasDriveSession() {
  return Boolean(state?.accessToken && Date.now() < Number(state.tokenExpiresAt || 0) - 15000);
}

function makeApiError(message, status = 400, code = "DRIVE_ERROR", retryable = false) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

async function parseGoogleError(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON Google errors are handled by the status fallback.
  }
  const message = payload?.error?.message || payload?.error_description || `Google API 回應 ${response.status}`;
  return makeApiError(message, response.status, payload?.error?.status || `HTTP_${response.status}`, response.status >= 500 || response.status === 429);
}

async function driveFetch(pathOrUrl, options = {}) {
  if (!hasDriveSession()) throw makeApiError("Google 授權已失效，請重新登入", 401, "AUTH_REQUIRED");
  const raw = Boolean(options.raw);
  const url = /^https?:\/\//i.test(String(pathOrUrl))
    ? String(pathOrUrl)
    : `${DRIVE_API_BASE}/${String(pathOrUrl).replace(/^\//, "")}`;
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${state.accessToken}`);
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=UTF-8");
  }
  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body,
    cache: options.cache || "no-store",
  });
  if (!response.ok) {
    const error = await parseGoogleError(response);
    if (response.status === 401) {
      state.accessToken = "";
      state.tokenExpiresAt = 0;
      state.user = null;
      state.canManage = false;
      renderAccount();
      renderSettings();
    }
    throw error;
  }
  if (raw) return response;
  if (response.status === 204) return {};
  const type = response.headers.get("content-type") || "";
  return type.includes("application/json") ? response.json() : response.text();
}

function driveQueryValue(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function managedQuery(entity, status = "ready") {
  const folderId = currentFolderId();
  if (!folderId) throw makeApiError("尚未設定 Google Drive Folder ID", 412, "FOLDER_REQUIRED");
  return [
    `'${driveQueryValue(folderId)}' in parents`,
    "trashed=false",
    `appProperties has { key='appId' and value='${APP_ID}' }`,
    `appProperties has { key='entity' and value='${driveQueryValue(entity)}' }`,
    ...(status ? [`appProperties has { key='status' and value='${driveQueryValue(status)}' }`] : []),
  ].join(" and ");
}

function driveUploader(file) {
  const properties = file.appProperties || {};
  const fallback = file.lastModifyingUser?.displayName || file.owners?.[0]?.displayName || state.user?.name || "Google 使用者";
  return {
    type: "google",
    displayName: properties.uploaderLabel || fallback,
    ipLabel: "",
  };
}

function publicDriveRecord(file, kind = "file") {
  const capabilities = file.capabilities || {};
  const entity = file.appProperties?.entity || kind;
  return normalizeRecord({
    ...file,
    kind: entity,
    sizeBytes: Number(file.size || 0),
    uploader: driveUploader(file),
    permissions: {
      canRename: Boolean(capabilities.canRename ?? capabilities.canEdit),
      canDelete: Boolean(capabilities.canTrash ?? capabilities.canEdit),
      canCopy: String(file.mimeType || "").startsWith("image/"),
    },
    contentUrl: file.webViewLink || "",
    thumbnailUrl: file.thumbnailLink || "",
    webViewLink: file.webViewLink || "",
  }, entity);
}

async function getDriveMetadata(fileId, fields = DRIVE_FILE_FIELDS) {
  const query = new URLSearchParams({ fields, supportsAllDrives: "true" });
  return driveFetch(`files/${encodeURIComponent(fileId)}?${query}`);
}

async function patchDriveMetadata(fileId, requestBody, fields = DRIVE_FILE_FIELDS) {
  const query = new URLSearchParams({ fields, supportsAllDrives: "true" });
  return driveFetch(`files/${encodeURIComponent(fileId)}?${query}`, {
    method: "PATCH",
    body: JSON.stringify(requestBody),
  });
}

async function listManagedFiles(entity, { pageSize = 100, pageToken = "", status = "ready" } = {}) {
  const query = new URLSearchParams({
    q: managedQuery(entity, status),
    pageSize: String(Math.min(1000, Math.max(1, Number(pageSize) || 100))),
    fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
    orderBy: "createdTime desc",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (pageToken) query.set("pageToken", pageToken);
  return driveFetch(`files?${query}`);
}

async function fetchDriveBlob(fileId) {
  const query = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
  const response = await driveFetch(`files/${encodeURIComponent(fileId)}?${query}`, { raw: true });
  return response.blob();
}

async function resolveDriveFolder(folderInput) {
  const input = normalizeFolderInput(folderInput);
  if (!input) throw makeApiError("請輸入 Google Drive Folder ID、網址或資料夾名稱", 400, "FOLDER_REQUIRED");
  const explicitId = extractFolderId(input);
  if (explicitId) {
    const folder = await getDriveMetadata(explicitId, "id,name,mimeType,webViewLink,driveId,capabilities(canAddChildren,canEdit)");
    if (folder.mimeType !== "application/vnd.google-apps.folder") {
      throw makeApiError("指定的 ID 不是 Google Drive 資料夾", 422, "NOT_A_FOLDER");
    }
    if (folder.capabilities?.canAddChildren === false && folder.capabilities?.canEdit === false) {
      throw makeApiError("目前帳戶沒有在此資料夾新增檔案的權限", 403, "FOLDER_WRITE_FORBIDDEN");
    }
    return folder;
  }

  if (/[\p{Cc}\\/]/u.test(input) || input.length > 200) {
    throw makeApiError("資料夾名稱格式不正確", 400, "INVALID_FOLDER_NAME");
  }
  const q = [
    "mimeType='application/vnd.google-apps.folder'",
    `name='${driveQueryValue(input)}'`,
    "trashed=false",
  ].join(" and ");
  const search = new URLSearchParams({
    q,
    pageSize: "20",
    fields: "files(id,name,mimeType,webViewLink,driveId,capabilities(canAddChildren,canEdit))",
    spaces: "drive",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const result = await driveFetch(`files?${search}`);
  const folders = result.files || [];
  if (folders.length > 1) throw makeApiError("找到多個同名資料夾，請改貼資料夾網址或 Folder ID", 409, "AMBIGUOUS_FOLDER");
  if (folders.length === 1) return folders[0];

  const createQuery = new URLSearchParams({ fields: "id,name,mimeType,webViewLink,driveId", supportsAllDrives: "true" });
  return driveFetch(`files?${createQuery}`, {
    method: "POST",
    body: JSON.stringify({
      name: input,
      mimeType: "application/vnd.google-apps.folder",
      appProperties: { appId: APP_ID, entity: "storageFolder", schema: "1" },
    }),
  });
}

function uploaderProperties() {
  const label = String(state.user?.name || state.user?.email || "Google 使用者").slice(0, 80);
  const key = String(state.user?.id || state.user?.email || "google-user").slice(0, 100);
  return {
    uploaderKind: "google",
    uploaderKey: key,
    uploaderLabel: label,
    guestIpMask: "",
  };
}

const uploadSessions = new Map();

async function createResumableSession(payload) {
  const folderId = currentFolderId();
  if (!folderId) throw makeApiError("請先設定 Google Drive Folder ID", 412, "FOLDER_REQUIRED");
  const entity = String(payload.kind || "file");
  if (!["file", "photo", "noteAttachment"].includes(entity)) throw makeApiError("不支援的檔案分類", 400, "INVALID_FILE_KIND");
  const sizeBytes = Number(payload.sizeBytes || 0);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw makeApiError("檔案大小必須大於 0", 400, "INVALID_FILE_SIZE");
  if (sizeBytes > CONFIG.MAX_FILE_BYTES) throw makeApiError("單一檔案不得超過 500 MB", 413, "FILE_TOO_LARGE");
  const mimeType = String(payload.mimeType || "application/octet-stream").slice(0, 100);
  if (entity === "photo" && !PHOTO_MIME_TYPES.has(mimeType.toLowerCase())) {
    throw makeApiError("相片圖庫只接受圖片檔案", 415, "UNSUPPORTED_MEDIA_TYPE");
  }
  const generated = await driveFetch("files/generateIds?count=1&space=drive&type=files");
  const fileId = generated.ids?.[0];
  if (!fileId) throw makeApiError("Google Drive 未產生檔案 ID", 502, "GENERATE_ID_FAILED", true);
  const uploadId = uid();
  const noteId = entity === "noteAttachment" ? String(payload.noteId || "").slice(0, 80) : "";
  const appProperties = {
    appId: APP_ID,
    schema: "1",
    entity,
    status: "pending",
    uploadId,
    expectedBytes: String(sizeBytes),
    ...uploaderProperties(),
    ...(noteId ? { noteId } : {}),
  };
  const metadata = {
    id: fileId,
    name: String(payload.name || "未命名檔案").slice(0, 200),
    parents: [folderId],
    mimeType,
    appProperties,
  };
  const query = new URLSearchParams({ uploadType: "resumable", supportsAllDrives: "true", fields: DRIVE_FILE_FIELDS });
  const response = await fetch(`${DRIVE_UPLOAD_BASE}/files?${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(sizeBytes),
    },
    body: JSON.stringify(metadata),
  });
  if (!response.ok) throw await parseGoogleError(response);
  const uploadUrl = response.headers.get("location");
  if (!uploadUrl) throw makeApiError("Google Drive 未回傳可續傳網址", 502, "UPLOAD_LOCATION_MISSING", true);
  uploadSessions.set(uploadId, { fileId, appProperties, entity });
  return {
    uploadId,
    fileId,
    uploadUrl,
    chunkSizeBytes: CONFIG.UPLOAD_CHUNK_BYTES,
    finalizeToken: uploadId,
  };
}

async function finalizeResumableSession(uploadId) {
  const session = uploadSessions.get(uploadId);
  if (!session) throw makeApiError("找不到上傳工作，請重新上傳", 404, "UPLOAD_SESSION_NOT_FOUND");
  const metadata = await getDriveMetadata(session.fileId);
  const appProperties = { ...(metadata.appProperties || session.appProperties), status: "ready" };
  const updated = await patchDriveMetadata(session.fileId, { appProperties });
  uploadSessions.delete(uploadId);
  return publicDriveRecord(updated, session.entity);
}

function makeMultipartBody(metadata, mediaBlob) {
  const boundary = `drivedock_${uid().replace(/[^a-z0-9]/gi, "")}`;
  const opening = [
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    `Content-Type: ${mediaBlob.type || "application/octet-stream"}\r\n\r\n`,
  ].join("");
  const closing = `\r\n--${boundary}--`;
  return { boundary, body: new Blob([opening, mediaBlob, closing]) };
}

async function multipartCreate(metadata, mediaBlob) {
  const { boundary, body } = makeMultipartBody(metadata, mediaBlob);
  const query = new URLSearchParams({ uploadType: "multipart", supportsAllDrives: "true", fields: DRIVE_FILE_FIELDS });
  return driveFetch(`${DRIVE_UPLOAD_BASE}/files?${query}`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function multipartUpdate(fileId, metadata, mediaBlob) {
  const { boundary, body } = makeMultipartBody(metadata, mediaBlob);
  const query = new URLSearchParams({ uploadType: "multipart", supportsAllDrives: "true", fields: DRIVE_FILE_FIELDS });
  return driveFetch(`${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?${query}`, {
    method: "PATCH",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

async function noteFromDriveFile(file) {
  let content = {};
  try {
    const blob = await fetchDriveBlob(file.id);
    content = JSON.parse(await blob.text());
  } catch {
    content = {};
  }
  const attachmentRows = Array.isArray(content.attachments)
    ? content.attachments
    : (Array.isArray(content.attachmentIds) ? content.attachmentIds.map((id) => ({ id })) : []);
  const attachments = attachmentRows.map((attachment) => ({
    id: String(attachment.id || ""),
    name: attachment.name || "附件",
    sizeBytes: Number(attachment.sizeBytes || 0),
    mimeType: attachment.mimeType || "application/octet-stream",
    contentUrl: attachment.id ? `https://drive.google.com/open?id=${encodeURIComponent(attachment.id)}` : "#",
  }));
  const capabilities = file.capabilities || {};
  return {
    id: file.id,
    title: content.title || file.name || "未命名備註",
    content: content.content || "",
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    uploader: driveUploader(file),
    attachments,
    permissions: {
      canEdit: Boolean(capabilities.canEdit),
      canDelete: Boolean(capabilities.canTrash),
    },
  };
}

async function listNotes(pageSize = 25, pageToken = "") {
  const result = await listManagedFiles("note", { pageSize, pageToken, status: "published" });
  const notes = [];
  for (let index = 0; index < (result.files || []).length; index += 4) {
    const batch = (result.files || []).slice(index, index + 4);
    const mapped = await Promise.all(batch.map(noteFromDriveFile));
    notes.push(...mapped);
  }
  return { notes, nextPageToken: result.nextPageToken || null, canManage: true };
}

async function setAttachmentState(fileId, status, noteId = "") {
  const metadata = await getDriveMetadata(fileId);
  if (metadata.appProperties?.entity !== "noteAttachment") throw makeApiError("附件分類不正確", 422, "INVALID_ATTACHMENT");
  const appProperties = { ...(metadata.appProperties || {}), status };
  if (noteId) appProperties.noteId = noteId;
  return patchDriveMetadata(fileId, { appProperties });
}

async function createNote(payload) {
  const folderId = currentFolderId();
  const title = String(payload.title || "").trim();
  const content = String(payload.content || "").trim();
  const noteId = String(payload.draftId || uid()).slice(0, 80);
  if (!title || !content) throw makeApiError("備註標題與內容不能為空白", 400, "NOTE_REQUIRED");
  const attachmentIds = [...new Set((payload.attachmentIds || []).map(String))].slice(0, 20);
  const attachments = [];
  for (const id of attachmentIds) {
    const file = await getDriveMetadata(id);
    attachments.push({ id: file.id, name: file.name, sizeBytes: Number(file.size || 0), mimeType: file.mimeType });
  }
  const json = new Blob([JSON.stringify({ schema: 1, title, content, attachmentIds, attachments })], { type: "application/json" });
  const created = await multipartCreate({
    name: title.slice(0, 200),
    parents: [folderId],
    mimeType: "application/json",
    appProperties: {
      appId: APP_ID,
      schema: "1",
      entity: "note",
      status: "published",
      noteId,
      ...uploaderProperties(),
    },
  }, json);
  await Promise.allSettled(attachmentIds.map((id) => setAttachmentState(id, "attached", noteId)));
  return noteFromDriveFile(created);
}

async function updateNote(noteFileId, payload) {
  const title = String(payload.title || "").trim();
  const content = String(payload.content || "").trim();
  if (!title || !content) throw makeApiError("備註標題與內容不能為空白", 400, "NOTE_REQUIRED");
  const metadata = await getDriveMetadata(noteFileId);
  const previousBlob = await fetchDriveBlob(noteFileId);
  let previous = {};
  try { previous = JSON.parse(await previousBlob.text()); } catch { previous = {}; }
  const noteId = String(metadata.appProperties?.noteId || noteFileId).slice(0, 80);
  const attachmentIds = [...new Set((payload.attachmentIds || []).map(String))].slice(0, 20);
  const attachments = [];
  for (const id of attachmentIds) {
    const file = await getDriveMetadata(id);
    attachments.push({ id: file.id, name: file.name, sizeBytes: Number(file.size || 0), mimeType: file.mimeType });
  }
  await Promise.allSettled(attachmentIds.map((id) => setAttachmentState(id, "attached", noteId)));
  const previousIds = new Set((previous.attachmentIds || previous.attachments?.map((item) => item.id) || []).map(String));
  const nextIds = new Set(attachmentIds);
  const removed = [...previousIds].filter((id) => !nextIds.has(id));
  await Promise.allSettled(removed.map((id) => patchDriveMetadata(id, { trashed: true })));
  const json = new Blob([JSON.stringify({ schema: 1, title, content, attachmentIds, attachments })], { type: "application/json" });
  const updated = await multipartUpdate(noteFileId, {
    name: title.slice(0, 200),
    mimeType: "application/json",
    appProperties: metadata.appProperties || {},
  }, json);
  return noteFromDriveFile(updated);
}

async function storageCandidates(olderThanHours = 168) {
  const threshold = Date.now() - Number(olderThanHours || 168) * 3600000;
  const entities = [
    ["file", "pending"],
    ["photo", "pending"],
    ["noteAttachment", "pending"],
    ["noteAttachment", "ready"],
  ];
  const candidates = [];
  for (const [entity, status] of entities) {
    const result = await listManagedFiles(entity, { pageSize: 1000, status });
    for (const file of result.files || []) {
      if (new Date(file.createdTime).getTime() < threshold) candidates.push(file);
    }
  }
  return {
    candidates: candidates.map((file) => ({ id: file.id, name: file.name, sizeBytes: Number(file.size || 0) })),
    totalBytes: candidates.reduce((sum, file) => sum + Number(file.size || 0), 0),
  };
}

async function api(path, options = {}) {
  const parsed = new URL(path, location.origin);
  const pathname = parsed.pathname;
  const method = String(options.method || "GET").toUpperCase();
  let body = {};
  if (typeof options.body === "string" && options.body) {
    try { body = JSON.parse(options.body); } catch { body = {}; }
  }

  if (pathname === "/api/config" && method === "GET") {
    const settings = directSettings();
    return {
      apiReady: true,
      driveConfigured: Boolean(settings.folderId),
      googleClientId: settings.googleClientId,
      folderName: settings.folderName,
      setupRequired: !settings.folderId,
      storageMode: "瀏覽器直接連線 Google Drive",
      anonymousUploads: false,
      publicDownloads: false,
      ipDisplayMode: "none",
      uploadChunkBytes: CONFIG.UPLOAD_CHUNK_BYTES,
    };
  }

  if (pathname === "/api/admin/settings" && method === "GET") {
    const settings = directSettings();
    return {
      revision: 1,
      googleClientId: settings.googleClientId,
      folderInput: settings.folderInput,
      folderId: settings.folderId,
      folderName: settings.folderName,
      folderWebViewLink: safeDriveFolderLink("", settings.folderId),
      setupRequired: !settings.folderId,
      storageLocked: false,
    };
  }

  if (pathname === "/api/admin/settings" && method === "PATCH") {
    const googleClientId = normalizeGoogleClientId(body.googleClientId);
    if (!isValidGoogleClientId(googleClientId)) throw makeApiError("Google Web Client ID 格式不正確", 400, "INVALID_CLIENT_ID");
    const folder = await resolveDriveFolder(body.folderInput);
    const next = saveDirectSettings({
      googleClientId,
      folderInput: body.folderInput,
      folderId: folder.id,
      folderName: folder.name,
    });
    return {
      revision: 1,
      googleClientId: next.GOOGLE_CLIENT_ID,
      folderInput: next.FOLDER_INPUT,
      folderId: next.DRIVE_FOLDER_ID,
      folderName: next.DRIVE_FOLDER_NAME,
      folderWebViewLink: folder.webViewLink || safeDriveFolderLink("", folder.id),
      setupRequired: false,
      storageLocked: false,
      folderCreated: false,
      reloadRequired: false,
    };
  }

  if (pathname === "/api/admin/storage" && method === "GET") return storageCandidates(168);
  if (pathname === "/api/admin/storage/cleanup" && method === "POST") {
    const result = await storageCandidates(Number(body.olderThanHours || 168));
    const results = [];
    for (const candidate of result.candidates) {
      try {
        await patchDriveMetadata(candidate.id, { trashed: true }, "id,trashed");
        results.push({ id: candidate.id, success: true });
      } catch (error) {
        results.push({ id: candidate.id, success: false, message: error.message });
      }
    }
    return { results };
  }

  if (pathname === "/api/files" && method === "GET") {
    const kind = parsed.searchParams.get("kind") || "file";
    const result = await listManagedFiles(kind, {
      pageSize: parsed.searchParams.get("pageSize") || 100,
      pageToken: parsed.searchParams.get("pageToken") || "",
      status: "ready",
    });
    return {
      files: (result.files || []).map((file) => publicDriveRecord(file, kind)),
      nextPageToken: result.nextPageToken || null,
      canManage: true,
    };
  }

  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && method === "PATCH") {
    const fileId = decodeURIComponent(fileMatch[1]);
    const updated = await patchDriveMetadata(fileId, { name: String(body.name || "").slice(0, 200) });
    return { file: publicDriveRecord(updated, updated.appProperties?.entity || "file") };
  }

  if (pathname === "/api/files/batch-trash" && method === "POST") {
    const results = [];
    for (const id of [...new Set((body.ids || []).map(String))].slice(0, 200)) {
      try {
        await patchDriveMetadata(id, { trashed: true }, "id,trashed");
        results.push({ id, success: true });
      } catch (error) {
        results.push({ id, success: false, message: error.message });
      }
    }
    return { results };
  }

  if (pathname === "/api/uploads/session" && method === "POST") {
    return { session: await createResumableSession(body) };
  }
  const finalizeMatch = pathname.match(/^\/api\/uploads\/([^/]+)\/finalize$/);
  if (finalizeMatch && method === "POST") {
    return { file: await finalizeResumableSession(decodeURIComponent(finalizeMatch[1])) };
  }

  if (pathname === "/api/notes" && method === "GET") {
    return listNotes(parsed.searchParams.get("pageSize") || 25, parsed.searchParams.get("pageToken") || "");
  }
  if (pathname === "/api/notes" && method === "POST") return { note: await createNote(body) };
  const noteMatch = pathname.match(/^\/api\/notes\/([^/]+)$/);
  if (noteMatch && method === "PATCH") return { note: await updateNote(decodeURIComponent(noteMatch[1]), body) };

  throw makeApiError(`不支援的前端 API 路徑：${pathname}`, 404, "UNSUPPORTED_ROUTE");
}

async function apiAll(basePath, collectionKey, maxItems = 1000) {
  const items = [];
  let pageToken = "";
  let canManage = false;
  do {
    const separator = basePath.includes("?") ? "&" : "?";
    const result = await api(`${basePath}${pageToken ? `${separator}pageToken=${encodeURIComponent(pageToken)}` : ""}`);
    items.push(...(result[collectionKey] || result.items || []));
    canManage = Boolean(result.canManage ?? canManage);
    pageToken = result.nextPageToken || "";
  } while (pageToken && items.length < maxItems);
  return { items: items.slice(0, maxItems), canManage };
}


const FILE_COLUMNS = {
  name: { label: "檔案名稱", sortable: true },
  uploader: { label: "上傳者", sortable: true },
  sizeBytes: { label: "檔案大小 (MB)", sortable: true },
  extension: { label: "副檔名", sortable: true },
  createdTime: { label: "上傳時間", sortable: true },
};
const DEFAULT_COLUMN_ORDER = ["name", "uploader", "sizeBytes", "extension", "createdTime"];
const DEFAULT_SETTING_ORDER = ["drive", "upload", "auth", "privacy", "appearance", "version"];

const state = {
  route: "files",
  user: null,
  canManage: false,
  accessToken: "",
  tokenExpiresAt: 0,
  tokenClient: null,
  tokenClientId: "",
  files: [],
  photos: [],
  notes: [],
  filesLoaded: false,
  photosLoaded: false,
  notesLoaded: false,
  selectedFiles: new Set(),
  selectedPhotos: new Set(),
  sort: readLocalJson("drivedock_file_sort", { key: "createdTime", direction: "desc" }),
  columnOrder: readLocalJson("drivedock_column_order", DEFAULT_COLUMN_ORDER).filter((key) => FILE_COLUMNS[key]),
  fileSearch: "",
  photoFilter: "all",
  upload: {
    kind: "file",
    queue: [],
    active: false,
    opener: null,
    transferredBytes: 0,
    speedSamples: [],
  },
  noteAttachments: [],
  noteExistingAttachments: [],
  noteReadOnly: false,
  viewerPhoto: null,
  copyingPhotoId: "",
  installPrompt: null,
  apiConfig: null,
  adminSettings: null,
  googleClientId: CONFIG.GOOGLE_CLIENT_ID,
  googleSignInClientId: "",
  pendingFolderInput: "",
  photoObjectUrl: "",
  googleSetupBusy: false,
  googleSetupDirty: false,
  googleSetupFeedback: null,
  lastModalFocus: null,
  version: {
    current: APP_VERSION,
    latest: APP_VERSION,
    buildDate: APP_BUILD_DATE,
    cacheName: APP_CACHE_NAME,
    lastChecked: readLocalJson("drivedock_last_update_check", null),
    checking: false,
    updating: false,
    updateAvailable: false,
    error: "",
    releaseNotes: [],
    autoUpdate: readLocalJson("drivedock_auto_update", true) !== false,
  },
};

if (state.columnOrder.length !== DEFAULT_COLUMN_ORDER.length) {
  state.columnOrder = [...DEFAULT_COLUMN_ORDER];
}

const ROUTES = {
  files: { title: "檔案總覽", eyebrow: "P0 · GOOGLE DRIVE" },
  notes: { title: "共享備註", eyebrow: "P1 · SHARED NOTES" },
  photos: { title: "相片圖庫", eyebrow: "P2 · VISUAL LIBRARY" },
  settings: { title: "系統設定", eyebrow: "P3 · CONTROL CENTER" },
};

function renderVersionInfo() {
  const version = state.version;
  const currentLabel = formatVersion(version.current);
  const latestLabel = version.latest ? formatVersion(version.latest) : "尚未取得";
  const topValue = $("#top-version-value");
  if (topValue) topValue.textContent = currentLabel;
  if ($("#settings-version-pill")) $("#settings-version-pill").textContent = currentLabel;
  if ($("#overview-version")) $("#overview-version").textContent = currentLabel;
  if ($("#current-version-value")) $("#current-version-value").textContent = currentLabel;
  if ($("#latest-version-value")) $("#latest-version-value").textContent = version.checking ? "檢查中" : latestLabel;
  if ($("#build-date-value")) $("#build-date-value").textContent = version.buildDate || APP_BUILD_DATE;
  if ($("#cache-version-value")) $("#cache-version-value").textContent = version.cacheName || APP_CACHE_NAME;
  if ($("#last-update-check")) $("#last-update-check").textContent = formatCheckTime(version.lastChecked);
  if ($("#auto-update-toggle")) $("#auto-update-toggle").checked = version.autoUpdate;

  const status = $("#update-status-panel");
  const stateBadge = $("#version-setting-state");
  const overviewState = $("#overview-update-state");
  const updateButton = $("#apply-update");
  const checkButton = $("#check-update");
  if (!status || !stateBadge || !overviewState || !updateButton || !checkButton) return;

  let statusState = "current";
  let title = "已是最新版本";
  let message = `目前使用 ${currentLabel}，系統會在啟動時自動檢查更新。`;
  let icon = "✓";
  let badge = "最新版";

  if (version.updating) {
    statusState = "updating";
    title = "正在套用更新";
    message = "正在更新離線快取與程式檔案，完成後會自動重新載入。";
    icon = "↻";
    badge = "更新中";
  } else if (version.checking) {
    statusState = "checking";
    title = "正在檢查版本";
    message = "正在讀取最新版本資訊。";
    icon = "↻";
    badge = "檢查中";
  } else if (version.error) {
    statusState = "error";
    title = "暫時無法檢查更新";
    message = version.error;
    icon = "!";
    badge = "檢查失敗";
  } else if (version.updateAvailable) {
    statusState = "available";
    title = `發現新版本 ${latestLabel}`;
    message = version.releaseNotes[0] || "可立即更新至最新版本。";
    icon = "↑";
    badge = "可更新";
  }

  status.dataset.state = statusState;
  $("#update-status-title").textContent = title;
  $("#update-status-message").textContent = message;
  $(".update-status-icon", status).textContent = icon;
  stateBadge.textContent = badge;
  overviewState.textContent = version.updating
    ? "正在更新"
    : version.updateAvailable
      ? `可更新至 ${latestLabel}`
      : version.error
        ? "更新檢查失敗"
        : version.checking
          ? "正在檢查"
          : "已是最新版本";
  updateButton.hidden = !version.updateAvailable;
  updateButton.disabled = version.updating || version.checking || !navigator.onLine;
  checkButton.disabled = version.updating || version.checking || !navigator.onLine;
}

async function checkForAppUpdate({ manual = false, autoApply = true } = {}) {
  if (!navigator.onLine) {
    state.version.checking = false;
    state.version.error = "目前沒有網路連線，恢復連線後再檢查。";
    renderVersionInfo();
    if (manual) showToast("目前離線，無法檢查更新", "error");
    return false;
  }

  state.version.checking = true;
  state.version.error = "";
  renderVersionInfo();
  try {
    const url = new URL(VERSION_MANIFEST_URL, location.href);
    url.searchParams.set("_", String(Date.now()));
    const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`版本伺服器回應 ${response.status}`);
    const manifest = await response.json();
    const latest = String(manifest.version || "").trim();
    if (!latest) throw new Error("版本檔缺少 version 欄位");

    state.version.latest = latest;
    state.version.buildDate = String(manifest.buildDate || state.version.buildDate || APP_BUILD_DATE);
    state.version.cacheName = String(manifest.cacheName || `drivedock-v${latest}`);
    state.version.releaseNotes = Array.isArray(manifest.releaseNotes) ? manifest.releaseNotes.filter(Boolean).slice(0, 5) : [];
    state.version.updateAvailable = compareVersions(latest, APP_VERSION) > 0;
    state.version.lastChecked = new Date().toISOString();
    state.version.error = "";
    localStorage.setItem("drivedock_last_update_check", JSON.stringify(state.version.lastChecked));
    renderVersionInfo();

    if (state.version.updateAvailable) {
      if (manual) showToast(`發現新版本 ${formatVersion(latest)}`);
      if (autoApply && state.version.autoUpdate) await applyAppUpdate({ automatic: true });
      return true;
    }
    if (manual) showToast(`目前已是最新版本 ${formatVersion(APP_VERSION)}`);
    return false;
  } catch (error) {
    state.version.error = `請確認 version.json 與網路狀態。${error?.message ? `（${error.message}）` : ""}`;
    if (manual) showToast("版本檢查失敗", "error");
    return false;
  } finally {
    state.version.checking = false;
    renderVersionInfo();
  }
}

async function waitForWorkerActivation(worker, timeoutMs = 4000) {
  if (!worker || worker.state === "activated") return;
  await Promise.race([
    new Promise((resolve) => {
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") resolve();
      });
    }),
    wait(timeoutMs),
  ]);
}

async function applyAppUpdate({ automatic = false } = {}) {
  if (state.version.updating) return;
  state.version.updating = true;
  state.version.error = "";
  renderVersionInfo();
  try {
    sessionStorage.setItem("drivedock_update_notice", `已更新至 ${formatVersion(state.version.latest)}`);
    if ("serviceWorker" in navigator) {
      const registration = (await navigator.serviceWorker.getRegistration("./")) || (await navigator.serviceWorker.ready);
      const controllerChange = new Promise((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      });
      await registration.update();
      const worker = registration.waiting || registration.installing;
      if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
      if (worker) await waitForWorkerActivation(worker);
      registration.active?.postMessage({ type: "CLEAR_OLD_CACHES" });
      await Promise.race([controllerChange, wait(1400)]);
    }
    if ("caches" in globalThis) {
      const cacheKeys = await caches.keys();
      await Promise.all(
        cacheKeys
          .filter((key) => key.startsWith("drivedock-") && key !== state.version.cacheName)
          .map((key) => caches.delete(key)),
      );
    }
    location.reload();
  } catch (error) {
    state.version.updating = false;
    state.version.error = `更新套用失敗：${error.message}`;
    renderVersionInfo();
    if (!automatic) showToast("更新失敗，請稍後再試", "error");
  }
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" });
  } catch (error) {
    console.warn("Service worker registration failed", error);
    return null;
  }
}

function routeFromHash() {
  const value = location.hash.replace(/^#/, "").split("?")[0];
  return ROUTES[value] ? value : "files";
}

function applyRoute() {
  state.route = routeFromHash();
  $$("[data-route]").forEach((page) => page.classList.toggle("is-active", page.dataset.route === state.route));
  $$('[data-route-link]').forEach((link) => {
    if (link.dataset.routeLink === state.route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#page-title").textContent = ROUTES[state.route].title;
  $("#page-eyebrow").textContent = ROUTES[state.route].eyebrow;
  document.title = `${ROUTES[state.route].title} · 雲匣 DriveDock`;

  if (state.route === "files") loadFiles();
  if (state.route === "notes") loadNotes();
  if (state.route === "photos") loadPhotos();
  if (state.route === "settings") {
    renderSettings();
    if (state.canManage && !state.adminSettings && !state.googleSetupBusy) void loadAdminSettings();
  }

  const query = location.hash.split("?")[1] || "";
  if (state.route === "files" && new URLSearchParams(query).get("upload") === "file") {
    history.replaceState(null, "", `${location.pathname}${location.search}#files`);
    openUpload("file");
  }
  $("#main-content").focus({ preventScroll: true });
}

function updateOnlineStatus() {
  const online = navigator.onLine;
  const dot = $("#connection-dot");
  dot.classList.toggle("is-online", online);
  dot.classList.toggle("is-offline", !online);
  $("#connection-label").textContent = online ? "網路連線正常" : "離線模式";
  if (!online) setSyncStatus("離線，暫停上傳", "offline");
  else if (!hasDriveSession()) setSyncStatus("請登入 Google", "offline");
  else if (!currentFolderId()) setSyncStatus("請設定 Drive 資料夾", "checking");
  else setSyncStatus("Drive 已連線", "online");
  $("#scan-storage").disabled = !hasDriveSession() || !currentFolderId() || !online;
  $("#cleanup-storage").disabled = !hasDriveSession() || !currentFolderId() || !online;
  renderGoogleSetup();
}

function setSyncStatus(label, status = "checking") {
  const pill = $("#sync-pill");
  $("span:last-child", pill).textContent = label;
  pill.title = label;
  pill.setAttribute("aria-label", label);
  const dot = $(".status-dot", pill);
  dot.classList.toggle("is-online", status === "online");
  dot.classList.toggle("is-offline", status === "offline");
}

function applyTheme(theme, persist = true) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  $("meta[name='theme-color']")?.setAttribute("content", next === "dark" ? "#08111f" : "#eef3f8");
  $("#theme-toggle").textContent = next === "dark" ? "☼" : "☾";
  $("#theme-toggle").setAttribute("aria-label", next === "dark" ? "切換亮色模式" : "切換深色模式");
  if (persist) localStorage.setItem("drivedock_theme", next);
}

function toggleTheme() {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

function renderAccount() {
  const user = state.user;
  const avatar = $("#account-avatar");
  avatar.replaceChildren();
  if (user?.picture) {
    const image = make("img");
    image.src = user.picture;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    avatar.append(image);
  } else {
    avatar.textContent = initials(user?.name || "?");
  }
  $("#account-name").textContent = user?.name || "Google 帳戶";
  $("#account-status").textContent = user ? "Drive 已授權" : state.googleClientId ? "點此連接 Google" : "尚未設定 Client ID";
  $("#google-signin").hidden = Boolean(user);
  $("#google-signout").hidden = !user;
  $("#auth-setting-state").textContent = user ? "已授權" : "未登入";
  $("#scan-storage").disabled = !hasDriveSession() || !currentFolderId() || !navigator.onLine;
  $("#cleanup-storage").disabled = !hasDriveSession() || !currentFolderId() || !navigator.onLine;
  renderGoogleSetup();
}

async function restoreSession() {
  state.user = null;
  state.canManage = false;
  state.accessToken = "";
  state.tokenExpiresAt = 0;
  renderAccount();
}

async function finishGoogleAuthorization(response) {
  if (!response?.access_token) {
    throw makeApiError(response?.error_description || response?.error || "Google 未回傳存取權杖", 401, "TOKEN_FAILED");
  }
  state.accessToken = response.access_token;
  state.tokenExpiresAt = Date.now() + Math.max(60, Number(response.expires_in || 3600)) * 1000;
  localStorage.setItem("drivedock_oauth_granted", "1");

  const userResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${state.accessToken}` },
    cache: "no-store",
  });
  if (!userResponse.ok) throw await parseGoogleError(userResponse);
  const profile = await userResponse.json();
  state.user = {
    id: String(profile.sub || profile.id || profile.email || ""),
    name: profile.name || profile.email || "Google 使用者",
    email: profile.email || "",
    picture: profile.picture || "",
  };
  state.canManage = true;
  localStorage.setItem("drivedock_profile_hint", JSON.stringify({ name: state.user.name }));
  renderAccount();
  closeAccountMenu();
  setSyncStatus("Google Drive 已授權", "online");

  const settings = directSettings();
  if (settings.folderInput && (!settings.folderId || state.pendingFolderInput)) {
    try {
      const result = await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify({
          googleClientId: state.googleClientId,
          folderInput: state.pendingFolderInput || settings.folderInput,
        }),
      });
      state.adminSettings = normalizeAdminSettings(result);
      state.apiConfig = {
        ...(state.apiConfig || {}),
        googleClientId: result.googleClientId,
        folderName: result.folderName,
        driveConfigured: true,
        setupRequired: false,
      };
      state.pendingFolderInput = "";
      state.googleSetupDirty = false;
      setGoogleSetupFeedback("success", "已連接");
    } catch (error) {
      setGoogleSetupFeedback("error", "資料夾驗證失敗");
      showToast(`Google 已登入，但資料夾無法使用：${error.message}`, "error");
    }
  }

  state.filesLoaded = false;
  state.photosLoaded = false;
  state.notesLoaded = false;
  await Promise.all([loadFiles(true), loadPhotos(true), loadNotes(true)]);
  renderSettings();
  showToast(`已連接 ${state.user.name} 的 Google Drive`);
}

function initializeGoogleSignIn(attempt = 0, force = false) {
  const clientId = normalizeGoogleClientId(state.googleClientId || directSettings().googleClientId || CONFIG.GOOGLE_CLIENT_ID);
  if (!clientId || !isValidGoogleClientId(clientId)) return;
  if (!globalThis.google?.accounts?.oauth2) {
    if (attempt < 60) setTimeout(() => initializeGoogleSignIn(attempt + 1, force), 250);
    return;
  }
  if (!force && state.tokenClient && state.tokenClientId === clientId) return;
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GOOGLE_OAUTH_SCOPE,
    callback: (response) => {
      void finishGoogleAuthorization(response).catch((error) => {
        showToast(`Google 授權失敗：${error.message}`, "error");
        renderAccount();
      });
    },
    error_callback: (error) => {
      showToast(`Google 授權視窗失敗：${error?.message || error?.type || "請確認 OAuth 網域設定"}`, "error");
    },
  });
  state.tokenClientId = clientId;
  state.googleSignInClientId = clientId;
  renderAccount();
}

function requestGoogleSignIn({ forceConsent = false } = {}) {
  const clientId = normalizeGoogleClientId(state.googleClientId || directSettings().googleClientId || CONFIG.GOOGLE_CLIENT_ID);
  if (!isValidGoogleClientId(clientId)) {
    location.hash = "#settings";
    showToast("請先填入有效的 Google OAuth Web Client ID", "error");
    return;
  }
  initializeGoogleSignIn(0, true);
  if (!state.tokenClient) {
    showToast("Google 授權服務尚未載入，請稍後重試", "error");
    return;
  }
  const hasGrantedBefore = localStorage.getItem("drivedock_oauth_granted") === "1";
  state.tokenClient.requestAccessToken({ prompt: forceConsent || !hasGrantedBefore ? "consent" : "" });
}

async function signOut() {
  const token = state.accessToken;
  if (token && globalThis.google?.accounts?.oauth2?.revoke) {
    await new Promise((resolve) => google.accounts.oauth2.revoke(token, resolve));
  }
  if (state.photoObjectUrl) URL.revokeObjectURL(state.photoObjectUrl);
  state.photoObjectUrl = "";
  state.accessToken = "";
  state.tokenExpiresAt = 0;
  state.user = null;
  state.canManage = false;
  state.files = [];
  state.photos = [];
  state.notes = [];
  state.filesLoaded = false;
  state.photosLoaded = false;
  state.notesLoaded = false;
  localStorage.removeItem("drivedock_profile_hint");
  renderAccount();
  renderFiles();
  renderPhotos();
  renderNotes();
  renderSettings();
  closeAccountMenu();
  setSyncStatus("請登入 Google", "offline");
  showToast("已撤銷此裝置的 Google Drive 授權");
}

function toggleAccountMenu() {
  const menu = $("#account-menu");
  menu.hidden = !menu.hidden;
  $("#account-button").setAttribute("aria-expanded", String(!menu.hidden));
}

function closeAccountMenu() {
  $("#account-menu").hidden = true;
  $("#account-button").setAttribute("aria-expanded", "false");
}

function uploaderLabel(record) {
  if (record.uploader?.type === "google") return record.uploader.displayName || "Google 使用者";
  return record.uploader?.ipLabel && record.uploader.ipLabel !== "—"
    ? record.uploader.ipLabel
    : record.uploader?.displayName || "訪客";
}

function getVisibleFiles() {
  const search = state.fileSearch.trim().toLocaleLowerCase("zh-Hant");
  const filtered = search
    ? state.files.filter((record) =>
        `${record.name} ${uploaderLabel(record)} ${record.extension}`.toLocaleLowerCase("zh-Hant").includes(search),
      )
    : [...state.files];
  const { key, direction } = state.sort;
  const multiplier = direction === "asc" ? 1 : -1;
  return filtered.sort((a, b) => {
    let left = a[key];
    let right = b[key];
    if (key === "uploader") {
      left = uploaderLabel(a);
      right = uploaderLabel(b);
    }
    let comparison;
    if (key === "sizeBytes") comparison = Number(left) - Number(right);
    else if (key === "createdTime") comparison = new Date(left).getTime() - new Date(right).getTime();
    else comparison = String(left || "").localeCompare(String(right || ""), "zh-Hant", { sensitivity: "base" });
    if (comparison !== 0) return comparison * multiplier;
    const timeFallback = new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime();
    if (timeFallback !== 0) return timeFallback;
    return a.id.localeCompare(b.id);
  });
}

function makeUploaderCell(record) {
  const wrapper = make("div", "uploader-cell");
  wrapper.append(make("span", "mini-avatar", initials(record.uploader?.type === "google" ? record.uploader.displayName : "IP")));
  const copy = make("span", "cell-stack");
  copy.append(make("strong", "", uploaderLabel(record)));
  copy.append(
    make(
      "small",
      "",
      record.uploader?.type === "google" ? "Google 帳戶" : record.uploader?.ipLabel ? "訪客 IP（已遮罩）" : "匿名訪客",
    ),
  );
  wrapper.append(copy);
  return wrapper;
}

function moveFileColumn(key, delta) {
  const index = state.columnOrder.indexOf(key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= state.columnOrder.length) return;
  [state.columnOrder[index], state.columnOrder[target]] = [state.columnOrder[target], state.columnOrder[index]];
  localStorage.setItem("drivedock_column_order", JSON.stringify(state.columnOrder));
  renderFiles();
}

function renderFileHead() {
  const head = $("#file-table-head");
  const row = make("tr");
  const selectTh = make("th");
  selectTh.scope = "col";
  const all = make("input");
  all.type = "checkbox";
  all.id = "select-all-files";
  all.setAttribute("aria-label", "選取目前列表全部檔案");
  const visibleIds = getVisibleFiles().map((record) => record.id);
  const selectedVisible = visibleIds.filter((id) => state.selectedFiles.has(id)).length;
  all.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  all.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  all.addEventListener("change", () => {
    visibleIds.forEach((id) => (all.checked ? state.selectedFiles.add(id) : state.selectedFiles.delete(id)));
    renderFiles();
  });
  selectTh.append(all);
  row.append(selectTh);

  const editTh = make("th", "", "編輯");
  editTh.scope = "col";
  row.append(editTh);

  state.columnOrder.forEach((key, index) => {
    const config = FILE_COLUMNS[key];
    const th = make("th");
    th.scope = "col";
    th.draggable = true;
    th.dataset.columnKey = key;
    th.setAttribute(
      "aria-sort",
      state.sort.key === key ? (state.sort.direction === "asc" ? "ascending" : "descending") : "none",
    );
    const sortButton = make("button", "sort-button");
    sortButton.type = "button";
    sortButton.append(make("span", "", config.label));
    const indicator = make(
      "span",
      "sort-indicator",
      state.sort.key === key ? (state.sort.direction === "asc" ? "↑" : "↓") : "↕",
    );
    indicator.setAttribute("aria-hidden", "true");
    sortButton.append(indicator);
    sortButton.addEventListener("click", () => {
      if (state.sort.key === key) state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
      else state.sort = { key, direction: key === "createdTime" ? "desc" : "asc" };
      localStorage.setItem("drivedock_file_sort", JSON.stringify(state.sort));
      renderFiles();
    });
    th.append(sortButton);

    const movers = make("span", "column-movers");
    const left = make("button", "column-move", "‹");
    left.type = "button";
    left.disabled = index === 0;
    left.title = `將「${config.label}」往左移`;
    left.setAttribute("aria-label", left.title);
    left.addEventListener("click", (event) => {
      event.stopPropagation();
      moveFileColumn(key, -1);
    });
    const right = make("button", "column-move", "›");
    right.type = "button";
    right.disabled = index === state.columnOrder.length - 1;
    right.title = `將「${config.label}」往右移`;
    right.setAttribute("aria-label", right.title);
    right.addEventListener("click", (event) => {
      event.stopPropagation();
      moveFileColumn(key, 1);
    });
    movers.append(left, right);
    th.append(movers);

    th.addEventListener("dragstart", () => {
      th.classList.add("is-dragging");
      state.draggedColumn = key;
    });
    th.addEventListener("dragend", () => {
      th.classList.remove("is-dragging");
      delete state.draggedColumn;
      $$(".is-drag-target", head).forEach((node) => node.classList.remove("is-drag-target"));
    });
    th.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (state.draggedColumn && state.draggedColumn !== key) th.classList.add("is-drag-target");
    });
    th.addEventListener("dragleave", () => th.classList.remove("is-drag-target"));
    th.addEventListener("drop", (event) => {
      event.preventDefault();
      const from = state.columnOrder.indexOf(state.draggedColumn);
      const to = state.columnOrder.indexOf(key);
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = state.columnOrder.splice(from, 1);
        state.columnOrder.splice(to, 0, moved);
        localStorage.setItem("drivedock_column_order", JSON.stringify(state.columnOrder));
        renderFiles();
      }
    });
    row.append(th);
  });
  head.replaceChildren(row);
}

function buildFileCell(record, key) {
  const td = make("td");
  td.dataset.column = key;
  td.dataset.label = FILE_COLUMNS[key].label;
  if (key === "name") {
    const wrapper = make("div", "file-name-cell");
    wrapper.append(make("span", "file-type-icon", record.extension === "—" ? "FILE" : record.extension.slice(0, 4)));
    const copy = make("span");
    const name = record.contentUrl || record.webViewLink ? make("a", "", record.name) : make("strong", "", record.name);
    if (name.tagName === "A") {
      name.href = record.contentUrl || record.webViewLink;
      name.target = "_blank";
      name.rel = "noopener";
    }
    copy.append(name, make("small", "", record.mimeType));
    wrapper.append(copy);
    td.append(wrapper);
  } else if (key === "uploader") {
    td.append(makeUploaderCell(record));
  } else if (key === "sizeBytes") {
    td.textContent = formatBytes(record.sizeBytes);
  } else if (key === "extension") {
    td.textContent = record.extension === "—" ? "—" : `.${record.extension}`;
  } else if (key === "createdTime") {
    const stack = make("span", "cell-stack");
    stack.append(make("strong", "", formatDate(record.createdTime)));
    stack.append(make("small", "", new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" }).format(
      Math.round((new Date(record.createdTime).getTime() - Date.now()) / 86400000),
      "day",
    )));
    td.append(stack);
  }
  return td;
}

function renderFiles() {
  renderFileHead();
  const records = getVisibleFiles();
  const body = $("#file-table-body");
  const fragment = document.createDocumentFragment();
  records.forEach((record) => {
    const row = make("tr", state.selectedFiles.has(record.id) ? "is-selected" : "");
    const selectTd = make("td");
    selectTd.dataset.column = "select";
    selectTd.dataset.label = "選取";
    const checkbox = make("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedFiles.has(record.id);
    checkbox.setAttribute("aria-label", `選取 ${record.name}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedFiles.add(record.id);
      else state.selectedFiles.delete(record.id);
      renderFiles();
    });
    selectTd.append(checkbox);
    row.append(selectTd);

    const editTd = make("td");
    editTd.dataset.column = "edit";
    editTd.dataset.label = "編輯";
    const edit = make("button", "row-action", "✎");
    edit.type = "button";
    edit.disabled = !record.permissions.canRename;
    edit.title = edit.disabled ? "只有檔案上傳者或管理員可以重新命名" : `重新命名 ${record.name}`;
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", () => openRename(record));
    editTd.append(edit);
    row.append(editTd);
    state.columnOrder.forEach((key) => row.append(buildFileCell(record, key)));
    fragment.append(row);
  });
  body.replaceChildren(fragment);
  $("#file-count").textContent = String(records.length);
  $("#file-summary-count").textContent = String(records.length);
  $("#file-summary-size").textContent = formatBytes(records.reduce((sum, record) => sum + record.sizeBytes, 0));
  const latestRecord = records.reduce((latest, record) => {
    if (!latest) return record;
    return new Date(record.createdTime) > new Date(latest.createdTime) ? record : latest;
  }, null);
  $("#file-summary-latest").textContent = latestRecord ? formatDate(latestRecord.createdTime, false) : "—";
  $("#file-summary-latest-name").textContent = latestRecord ? latestRecord.name : "尚無檔案";
  $("#file-empty").hidden = records.length > 0;
  $("#file-table").hidden = records.length === 0;
  $("#selected-file-count").textContent = String(state.selectedFiles.size);
  $("#delete-files").disabled = state.selectedFiles.size === 0 || !state.canManage || !navigator.onLine;
  $("#file-permission-note").lastElementChild.textContent = hasDriveSession()
    ? "重新命名與刪除權限依目前登入帳戶在 Google Drive 的實際權限決定。"
    : "請先登入 Google，才能讀取與管理指定資料夾。";
}

async function loadFiles(force = false) {
  if (!hasDriveSession() || !currentFolderId()) {
    state.files = [];
    state.filesLoaded = false;
    state.selectedFiles.clear();
    renderFiles();
    setSyncStatus(hasDriveSession() ? "請設定 Drive 資料夾" : "請登入 Google", hasDriveSession() ? "checking" : "offline");
    return;
  }
  if (state.filesLoaded && !force) {
    renderFiles();
    return;
  }
  setSyncStatus("同步檔案中");
  try {
    const result = await apiAll("/api/files?kind=file&orderBy=createdTime&direction=desc&pageSize=100", "files");
    state.files = result.items.map((item) => normalizeRecord(item, "file"));
    state.canManage = Boolean(result.canManage ?? state.canManage);
    state.filesLoaded = true;
    state.selectedFiles.clear();
    renderFiles();
    renderAccount();
    setSyncStatus("Drive 已同步", "online");
  } catch (error) {
    setSyncStatus("Drive 連線失敗", "offline");
    showToast(`無法載入檔案：${error.message}`, "error");
    renderFiles();
  }
}

function openRename(record) {
  if (!record.permissions.canRename) {
    showToast("您沒有重新命名這個檔案的權限", "error");
    return;
  }
  $("#rename-file-id").value = record.id;
  $("#rename-file-name").value = record.name;
  openModal("rename-modal", $("#rename-file-name"));
  $("#rename-file-name").select();
}

async function handleRename(event) {
  event.preventDefault();
  const id = $("#rename-file-id").value;
  const name = $("#rename-file-name").value.trim();
  if (!name || /[\u0000-\u001f\\/]/.test(name)) {
    showToast("檔案名稱不能為空白，也不能含路徑或控制字元", "error");
    return;
  }
  try {
    if (DEMO_MODE) {
      const record = state.files.find((item) => item.id === id);
      if (record) {
        record.name = name;
        record.extension = extensionOf(name);
      }
    } else {
      await api(`/api/files/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ name, preserveExtension: false }),
      });
      state.filesLoaded = false;
    }
    closeModal($("#rename-modal"));
    await loadFiles(true);
    showToast("檔案名稱已更新");
  } catch (error) {
    showToast(`重新命名失敗：${error.message}`, "error");
  }
}

async function deleteSelectedFiles() {
  if (!state.canManage || state.selectedFiles.size === 0) return;
  const selectedNames = state.files
    .filter((item) => state.selectedFiles.has(item.id))
    .slice(0, 3)
    .map((item) => item.name)
    .join("、");
  const extra = state.selectedFiles.size > 3 ? ` 等 ${state.selectedFiles.size} 個檔案` : "";
  if (!confirm(`確定要將「${selectedNames}」${extra}移到 Google Drive 垃圾桶嗎？`)) return;
  const ids = [...state.selectedFiles];
  try {
    if (DEMO_MODE) {
      state.files = state.files.filter((item) => !state.selectedFiles.has(item.id));
    } else {
      const result = await api("/api/files/batch-trash", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      const failed = (result.results || []).filter((item) => !item.success);
      if (failed.length) showToast(`${failed.length} 個檔案刪除失敗，其餘已完成`, "error");
      state.filesLoaded = false;
    }
    state.selectedFiles.clear();
    await loadFiles(true);
    showToast(`${ids.length} 個檔案已移到垃圾桶`);
  } catch (error) {
    showToast(`批次刪除失敗：${error.message}`, "error");
  }
}

function visiblePhotos() {
  const current = new Date();
  const startToday = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const startWeek = startToday - 6 * 86400000;
  return [...state.photos]
    .filter((photo) => {
      const time = new Date(photo.createdTime).getTime();
      if (state.photoFilter === "today") return time >= startToday;
      if (state.photoFilter === "week") return time >= startWeek;
      return true;
    })
    .sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
}

function renderPhotos() {
  const body = $("#photo-table-body");
  const photos = visiblePhotos();
  const fragment = document.createDocumentFragment();
  photos.forEach((photo) => {
    const row = make("tr", state.selectedPhotos.has(photo.id) ? "is-selected" : "");

    const selectTd = make("td");
    selectTd.dataset.label = "選取";
    const checkbox = make("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedPhotos.has(photo.id);
    checkbox.setAttribute("aria-label", `選取 ${photo.name}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedPhotos.add(photo.id);
      else state.selectedPhotos.delete(photo.id);
      renderPhotos();
    });
    selectTd.append(checkbox);

    const previewTd = make("td");
    previewTd.dataset.label = "預覽";
    const preview = make("button", "photo-table-preview");
    preview.type = "button";
    preview.setAttribute("aria-label", `開啟 ${photo.name}`);
    const image = make("img");
    image.src = photo.thumbnailUrl || photo.contentUrl || "./icon-512.png";
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      if (!image.src.endsWith("icon-512.png")) image.src = "./icon-512.png";
    });
    preview.append(image);
    preview.addEventListener("click", () => openPhotoViewer(photo));
    previewTd.append(preview);

    const nameTd = make("td");
    nameTd.dataset.label = "檔案名稱";
    const nameStack = make("span", "cell-stack photo-name-stack");
    nameStack.append(make("strong", "", photo.name));
    nameStack.append(make("small", "", photo.mimeType || "圖片"));
    nameTd.append(nameStack);

    const uploaderTd = make("td");
    uploaderTd.dataset.label = "上傳者";
    uploaderTd.append(makeUploaderCell(photo));

    const timeTd = make("td");
    timeTd.dataset.label = "上傳時間";
    const timeStack = make("span", "cell-stack");
    timeStack.append(make("strong", "", formatDate(photo.createdTime, false)));
    timeStack.append(make("small", "", new Date(photo.createdTime).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })));
    timeTd.append(timeStack);

    const sizeTd = make("td", "", formatBytes(photo.sizeBytes));
    sizeTd.dataset.label = "大小";

    const actionTd = make("td");
    actionTd.dataset.label = "操作";
    const actions = make("div", "table-row-actions");
    const view = make("button", "row-action row-action-text", "預覽");
    view.type = "button";
    view.addEventListener("click", () => openPhotoViewer(photo));
    const copy = make("button", "row-action row-action-text photo-copy-action", state.copyingPhotoId === photo.id ? "處理中" : "複製");
    copy.type = "button";
    copy.dataset.photoId = photo.id;
    copy.disabled = Boolean(state.copyingPhotoId);
    copy.setAttribute("aria-label", `複製 ${photo.name}`);
    copy.addEventListener("click", () => copyCurrentPhoto(photo));
    actions.append(view, copy);
    actionTd.append(actions);

    row.append(selectTd, previewTd, nameTd, uploaderTd, timeTd, sizeTd, actionTd);
    fragment.append(row);
  });
  body.replaceChildren(fragment);
  $("#photo-count").textContent = String(photos.length);
  $("#photo-empty").hidden = photos.length > 0;
  $("#photo-table").hidden = photos.length === 0;
  $("#selected-photo-count").textContent = String(state.selectedPhotos.size);
  $("#delete-photos").disabled = state.selectedPhotos.size === 0 || !state.canManage || !navigator.onLine;
}

async function loadPhotos(force = false) {
  if (!hasDriveSession() || !currentFolderId()) {
    state.photos = [];
    state.photosLoaded = false;
    state.selectedPhotos.clear();
    renderPhotos();
    setSyncStatus(hasDriveSession() ? "請設定 Drive 資料夾" : "請登入 Google", hasDriveSession() ? "checking" : "offline");
    return;
  }
  if (state.photosLoaded && !force) {
    renderPhotos();
    return;
  }
  setSyncStatus("同步相片中");
  try {
    const result = await apiAll("/api/files?kind=photo&orderBy=createdTime&direction=desc&pageSize=100", "files");
    state.photos = result.items.map((item) => normalizeRecord(item, "photo"));
    state.canManage = Boolean(result.canManage ?? state.canManage);
    state.photosLoaded = true;
    state.selectedPhotos.clear();
    renderPhotos();
    renderAccount();
    setSyncStatus("Drive 已同步", "online");
  } catch (error) {
    setSyncStatus("Drive 連線失敗", "offline");
    showToast(`無法載入相片：${error.message}`, "error");
    renderPhotos();
  }
}

function openPhotoViewer(photo) {
  state.viewerPhoto = photo;
  $("#photo-viewer-title").textContent = photo.name;
  $("#photo-viewer-meta").textContent = `${formatDate(photo.createdTime)} · ${formatBytes(photo.sizeBytes)} · ${uploaderLabel(photo)}`;
  const image = $("#photo-viewer-image");
  if (state.photoObjectUrl) URL.revokeObjectURL(state.photoObjectUrl);
  state.photoObjectUrl = "";
  image.src = photo.thumbnailUrl || "./icon-512.png";
  image.alt = photo.name;
  const copyButton = $("#copy-photo");
  copyButton.disabled = Boolean(state.copyingPhotoId);
  copyButton.dataset.mobileLabel = state.copyingPhotoId ? "處理中" : "複製";
  openModal("photo-viewer", copyButton);
  void fetchDriveBlob(photo.id)
    .then((blob) => {
      if (state.viewerPhoto?.id !== photo.id) return;
      state.photoObjectUrl = URL.createObjectURL(blob);
      image.src = state.photoObjectUrl;
    })
    .catch((error) => {
      console.warn("DriveDock preview failed", error);
      showToast(`無法載入完整圖片：${error.message}`, "error");
    });
}

function appendUrlParameter(value, key, parameterValue) {
  try {
    const url = new URL(value, location.href);
    url.searchParams.set(key, parameterValue);
    return url.href;
  } catch {
    const separator = String(value).includes("?") ? "&" : "?";
    return `${value}${separator}${encodeURIComponent(key)}=${encodeURIComponent(parameterValue)}`;
  }
}

function photoCopySources(photo) {
  return [photo.thumbnailUrl].filter(Boolean);
}

async function imageBlobToPng(blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("圖片內容為空白");
  if (blob.type === "image/png") return blob;

  let source;
  let width;
  let height;
  let cleanup = () => {};
  try {
    if (typeof createImageBitmap === "function") {
      source = await createImageBitmap(blob);
      width = source.width;
      height = source.height;
      cleanup = () => source.close?.();
    } else {
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      cleanup = () => URL.revokeObjectURL(objectUrl);
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("瀏覽器無法解碼這張圖片"));
        image.src = objectUrl;
      });
      source = image;
      width = image.naturalWidth;
      height = image.naturalHeight;
    }

    if (!width || !height) throw new Error("圖片尺寸無效");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("瀏覽器無法建立圖片轉換區");
    context.drawImage(source, 0, 0, width, height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error("無法將圖片轉換為 PNG"))),
        "image/png",
      ),
    );
  } finally {
    cleanup();
  }
}

async function fetchPhotoAsPng(photo) {
  const blob = await fetchDriveBlob(photo.id);
  if (!blob.type.startsWith("image/")) {
    throw new Error(`Google Drive 回傳的內容不是圖片（${blob.type || "未知格式"}）`);
  }
  return imageBlobToPng(blob);
}

function setPhotoCopyBusy(photo, busy) {
  state.copyingPhotoId = busy ? photo.id : "";
  const viewerButton = $("#copy-photo");
  if (viewerButton) {
    viewerButton.disabled = busy;
    viewerButton.setAttribute("aria-busy", busy ? "true" : "false");
    viewerButton.textContent = busy ? "複製中…" : "複製圖片";
    viewerButton.dataset.mobileLabel = busy ? "處理中" : "複製";
  }
  $$(".photo-copy-action").forEach((button) => {
    button.disabled = busy;
    if (button.dataset.photoId === photo.id) button.textContent = busy ? "處理中" : "複製";
  });
}

async function copyCurrentPhoto(photoOverride = null) {
  const photo = photoOverride || state.viewerPhoto;
  if (!photo || state.copyingPhotoId) return;
  if (!globalThis.ClipboardItem || !navigator.clipboard?.write) {
    showToast("此瀏覽器不支援直接複製圖片，請長按圖片後選擇「拷貝」", "error");
    return;
  }

  setPhotoCopyBusy(photo, true);
  try {
    // Safari / iOS 必須在點擊事件仍具使用者授權時呼叫 clipboard.write。
    // 將圖片讀取與 PNG 轉換包在 ClipboardItem Promise 內，可避免非同步處理後授權失效。
    const pngPromise = fetchPhotoAsPng(photo);
    const item = new ClipboardItem({ "image/png": pngPromise });
    await navigator.clipboard.write([item]);
    showToast("圖片已複製，可直接貼到支援圖片的 App");
  } catch (error) {
    console.error("DriveDock photo copy failed", error);
    showToast(`無法複製圖片：${error.message || "請長按圖片後選擇「拷貝」"}`, "error");
  } finally {
    setPhotoCopyBusy(photo, false);
  }
}

async function deleteSelectedPhotos() {
  if (!state.canManage || state.selectedPhotos.size === 0) return;
  const count = state.selectedPhotos.size;
  if (!confirm(`確定要將已選的 ${count} 張圖片移到 Google Drive 垃圾桶嗎？`)) return;
  const ids = [...state.selectedPhotos];
  try {
    if (DEMO_MODE) {
      state.photos = state.photos.filter((item) => !state.selectedPhotos.has(item.id));
    } else {
      const result = await api("/api/files/batch-trash", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      const failed = (result.results || []).filter((item) => !item.success);
      if (failed.length) showToast(`${failed.length} 張圖片刪除失敗，其餘已完成`, "error");
      state.photosLoaded = false;
    }
    state.selectedPhotos.clear();
    await loadPhotos(true);
    showToast(`${count} 張圖片已移到垃圾桶`);
  } catch (error) {
    showToast(`批次刪除失敗：${error.message}`, "error");
  }
}

function handlePaste(event) {
  if (state.route !== "photos" || isFormTarget(event.target) || !event.clipboardData) return;
  const files = [...event.clipboardData.items]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean)
    .map((file, index) => {
      const extension = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      return new File([file], `pasted-${stamp}-${index + 1}.${extension}`, { type: file.type });
    });
  if (!files.length) return;
  event.preventDefault();
  openUpload("photo", files);
  showToast(`已從剪貼簿加入 ${files.length} 張圖片，確認後再上傳`);
}

function handleCopyShortcut(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !$("#photo-viewer").hidden && !isFormTarget(event.target)) {
    event.preventDefault();
    copyCurrentPhoto();
  }
}

function normalizeNote(raw) {
  return {
    id: String(raw.id || uid()),
    title: raw.title || "未命名備註",
    content: raw.content || "",
    createdTime: raw.createdTime || raw.createdAt || new Date().toISOString(),
    modifiedTime: raw.modifiedTime || raw.updatedAt || raw.createdTime || new Date().toISOString(),
    uploader: {
      type: raw.uploader?.type || "anonymous",
      displayName: raw.uploader?.displayName || "訪客",
      ipLabel: raw.uploader?.ipLabel || "—",
    },
    attachments: (raw.attachments || []).map((attachment) => ({
      id: String(attachment.id || uid()),
      name: attachment.name || "附件",
      sizeBytes: Number(attachment.sizeBytes ?? attachment.size ?? 0),
      contentUrl: attachment.contentUrl || `https://drive.google.com/open?id=${encodeURIComponent(attachment.id)}`,
    })),
    permissions: {
      canEdit: Boolean(raw.permissions?.canEdit ?? raw.canEdit),
      canDelete: Boolean(raw.permissions?.canDelete ?? raw.canDelete),
    },
  };
}

function renderNotes() {
  const notes = [...state.notes].sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
  const body = $("#note-table-body");
  const fragment = document.createDocumentFragment();
  notes.forEach((note) => {
    const row = make("tr");
    const editTd = make("td");
    editTd.dataset.label = "編輯";
    const edit = make("button", "row-action", "✎");
    edit.type = "button";
    edit.disabled = !note.permissions.canEdit;
    edit.title = edit.disabled ? "只有備註作者或管理員可以編輯" : `編輯 ${note.title}`;
    edit.setAttribute("aria-label", edit.title);
    edit.addEventListener("click", () => openNoteModal(note, false));
    editTd.append(edit);

    const titleTd = make("td");
    titleTd.dataset.label = "標題名稱";
    const title = make("button", "note-title-button");
    title.type = "button";
    title.append(make("strong", "", note.title));
    title.append(make("span", "", note.content.replace(/\s+/g, " ")));
    title.addEventListener("click", () => openNoteModal(note, true));
    titleTd.append(title);

    const uploaderTd = make("td");
    uploaderTd.dataset.label = "上傳者";
    uploaderTd.append(makeUploaderCell(note));

    const timeTd = make("td", "", formatDate(note.createdTime));
    timeTd.dataset.label = "上傳時間";

    const attachmentsTd = make("td");
    attachmentsTd.dataset.label = "附件檔案";
    const links = make("div", "attachment-links");
    if (!note.attachments.length) links.append(make("span", "", "—"));
    note.attachments.forEach((attachment) => {
      const link = make("a", "attachment-link");
      link.href = attachment.contentUrl || "#";
      link.target = "_blank";
      link.rel = "noopener";
      link.title = `${attachment.name} · ${formatBytes(attachment.sizeBytes)}`;
      link.append(make("span", "", `⌁ ${attachment.name}`));
      links.append(link);
    });
    attachmentsTd.append(links);
    row.append(editTd, titleTd, uploaderTd, timeTd, attachmentsTd);
    fragment.append(row);
  });
  body.replaceChildren(fragment);
  $("#note-count").textContent = String(notes.length);
  const weekAgo = Date.now() - 7 * 86400000;
  $("#note-week-count").textContent = String(notes.filter((note) => new Date(note.createdTime).getTime() >= weekAgo).length);
  $("#note-attachment-count").textContent = String(notes.filter((note) => note.attachments.length > 0).length);
  $("#note-empty").hidden = notes.length > 0;
  $(".note-table").hidden = notes.length === 0;
}

async function loadNotes(force = false) {
  if (!hasDriveSession() || !currentFolderId()) {
    state.notes = [];
    state.notesLoaded = false;
    renderNotes();
    setSyncStatus(hasDriveSession() ? "請設定 Drive 資料夾" : "請登入 Google", hasDriveSession() ? "checking" : "offline");
    return;
  }
  if (state.notesLoaded && !force) {
    renderNotes();
    return;
  }
  setSyncStatus("同步備註中");
  try {
    const result = await apiAll("/api/notes?pageSize=25", "notes", 500);
    state.notes = result.items.map(normalizeNote);
    state.canManage = Boolean(result.canManage ?? state.canManage);
    state.notesLoaded = true;
    renderNotes();
    renderAccount();
    setSyncStatus("Drive 已同步", "online");
  } catch (error) {
    setSyncStatus("Drive 連線失敗", "offline");
    showToast(`無法載入備註：${error.message}`, "error");
    renderNotes();
  }
}

function openNoteModal(note = null, readOnly = false) {
  if (!note && (!hasDriveSession() || !currentFolderId())) {
    location.hash = "#settings";
    showToast(hasDriveSession() ? "請先設定 Google Drive 資料夾" : "請先登入 Google", "error");
    return;
  }
  state.noteAttachments = [];
  state.noteExistingAttachments = note ? [...note.attachments] : [];
  $("#note-id").value = note?.id || "";
  $("#note-title-input").value = note?.title || "";
  $("#note-content-input").value = note?.content || "";
  const effectiveReadOnly = Boolean(readOnly && !note?.permissions?.canEdit);
  state.noteReadOnly = effectiveReadOnly;
  $("#note-title-input").disabled = effectiveReadOnly;
  $("#note-content-input").disabled = effectiveReadOnly;
  $("#note-attachment-input").disabled = effectiveReadOnly;
  $(".attachment-picker", $("#note-modal")).hidden = effectiveReadOnly;
  $("#note-form button[type='submit']").hidden = effectiveReadOnly;
  $("#note-modal-title").textContent = note ? (effectiveReadOnly ? "檢視備註" : "編輯備註") : "新增備註";
  renderNoteAttachments();
  openModal("note-modal", effectiveReadOnly ? $("#note-content-input") : $("#note-title-input"));
}

function renderNoteAttachments() {
  const host = $("#note-attachment-list");
  const fragment = document.createDocumentFragment();
  state.noteExistingAttachments.forEach((attachment) => {
    const item = make("div", "attachment-item");
    item.append(make("span", "", `⌁ ${attachment.name} · ${formatBytes(attachment.sizeBytes)}`));
    const remove = make("button", "row-action", "×");
    remove.type = "button";
    remove.hidden = state.noteReadOnly;
    remove.setAttribute("aria-label", `移除附件 ${attachment.name}`);
    remove.addEventListener("click", () => {
      state.noteExistingAttachments = state.noteExistingAttachments.filter((entry) => entry.id !== attachment.id);
      renderNoteAttachments();
    });
    item.append(remove);
    fragment.append(item);
  });
  state.noteAttachments.forEach((file, index) => {
    const item = make("div", "attachment-item");
    item.append(make("span", "", `＋ ${file.name} · ${formatBytes(file.size)}`));
    const remove = make("button", "row-action", "×");
    remove.type = "button";
    remove.hidden = state.noteReadOnly;
    remove.setAttribute("aria-label", `移除附件 ${file.name}`);
    remove.addEventListener("click", () => {
      state.noteAttachments.splice(index, 1);
      renderNoteAttachments();
    });
    item.append(remove);
    fragment.append(item);
  });
  host.replaceChildren(fragment);
}

function addNoteAttachments(fileList) {
  const incoming = [...fileList];
  incoming.forEach((file) => {
    if (file.size > CONFIG.MAX_FILE_BYTES) {
      showToast(`${file.name} 超過 500 MB，未加入附件`, "error");
      return;
    }
    if (file.size === 0) {
      showToast(`${file.name} 是空檔案，未加入附件`, "error");
      return;
    }
    if (state.noteAttachments.length + state.noteExistingAttachments.length >= 20) {
      showToast("每則備註最多 20 個附件", "error");
      return;
    }
    state.noteAttachments.push(file);
  });
  $("#note-attachment-input").value = "";
  renderNoteAttachments();
}

async function handleNoteSubmit(event) {
  event.preventDefault();
  if (!hasDriveSession() || !currentFolderId()) {
    showToast(hasDriveSession() ? "請先設定 Google Drive 資料夾" : "請先登入 Google", "error");
    return;
  }
  const id = $("#note-id").value;
  const title = $("#note-title-input").value.trim();
  const content = $("#note-content-input").value.trim();
  if (!title || !content) {
    showToast("請填寫備註標題與內容", "error");
    return;
  }
  const submit = $("#note-form button[type='submit']");
  submit.disabled = true;
  const formProgress = $("#note-form-progress");
  const progressBar = $(".progress-track span", formProgress);
  try {
    const draftId = uid();
    const attachmentIds = state.noteExistingAttachments.map((item) => item.id);
    if (state.noteAttachments.length) {
      formProgress.hidden = false;
      const total = state.noteAttachments.reduce((sum, file) => sum + file.size, 0);
      let completed = 0;
      for (const file of state.noteAttachments) {
        const uploaded = await performUpload(file, "noteAttachment", (loaded) => {
          progressBar.style.width = `${Math.min(100, ((completed + loaded) / total) * 100)}%`;
        }, draftId);
        attachmentIds.push(uploaded.id || uploaded.fileId);
        completed += file.size;
      }
    }

    if (DEMO_MODE) {
      const addedAttachments = state.noteAttachments.map((file) => ({
        id: uid(),
        name: file.name,
        sizeBytes: file.size,
        contentUrl: "#",
      }));
      if (id) {
        const note = state.notes.find((item) => item.id === id);
        if (note) {
          note.title = title;
          note.content = content;
          note.modifiedTime = new Date().toISOString();
          note.attachments = [...state.noteExistingAttachments, ...addedAttachments];
        }
      } else {
        state.notes.unshift(
          normalizeNote({
            id: uid(),
            title,
            content,
            createdTime: new Date().toISOString(),
            uploader: state.user
              ? { type: "google", displayName: state.user.name }
              : { type: "anonymous", displayName: "訪客", ipLabel: "展示 IP" },
            attachments: addedAttachments,
            permissions: { canEdit: true, canDelete: true },
          }),
        );
      }
    } else if (id) {
      await api(`/api/notes/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title, content, attachmentIds }),
      });
      state.notesLoaded = false;
    } else {
      await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ draftId, title, content, attachmentIds }),
      });
      state.notesLoaded = false;
    }
    closeModal($("#note-modal"));
    await loadNotes(true);
    showToast(id ? "備註已更新" : "備註已新增");
  } catch (error) {
    showToast(`備註儲存失敗：${error.message}`, "error");
  } finally {
    submit.disabled = false;
    formProgress.hidden = true;
    progressBar.style.width = "0%";
  }
}

function openUpload(kind = "file", initialFiles = []) {
  if (state.upload.active) return;
  if (!hasDriveSession() || !currentFolderId()) {
    location.hash = "#settings";
    showToast(hasDriveSession() ? "請先設定 Google Drive 資料夾" : "請先登入 Google", "error");
    return;
  }
  state.upload.kind = kind;
  state.upload.queue = [];
  state.upload.transferredBytes = 0;
  state.upload.speedSamples = [];
  state.upload.opener = document.activeElement;
  const photoMode = kind === "photo";
  $("#upload-modal-title").textContent = photoMode ? "上傳圖片" : "上傳檔案";
  $("#upload-modal-kicker").textContent = photoMode ? "PHOTO UPLOAD" : "MULTI UPLOAD";
  $("#upload-input").accept = photoMode ? "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,image/avif" : "";
  $("#upload-picker-help").textContent = photoMode
    ? "可多選 JPG、PNG、WebP、GIF、HEIC 或 AVIF · 單檔 500 MB"
    : "可一次選擇多個檔案 · 單檔 500 MB";
  $("#progress-section").hidden = true;
  $("#start-upload").textContent = "開始上傳";
  $("#upload-modal-note").textContent = "檔案只會送到已設定的 Google Drive 資料夾。";
  renderUploadQueue();
  openModal("upload-modal", $("#upload-input"));
  if (initialFiles.length) addFilesToQueue(initialFiles);
}

function addFilesToQueue(fileList) {
  const incoming = [...fileList];
  let rejected = 0;
  for (const file of incoming) {
    if (state.upload.queue.length >= 20) {
      rejected += 1;
      continue;
    }
    const duplicate = state.upload.queue.some(
      (item) => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified,
    );
    if (duplicate) continue;
    let error = "";
    if (file.size === 0) error = "空檔案無法上傳";
    else if (file.size > CONFIG.MAX_FILE_BYTES) error = `超過 500 MB（${formatBytes(file.size)}）`;
    else if (state.upload.kind === "photo" && !PHOTO_MIME_TYPES.has(file.type.toLowerCase())) error = "不是支援的圖片格式";
    state.upload.queue.push({ id: uid(), file, status: error ? "invalid" : "queued", error, uploadedBytes: 0 });
  }
  if (rejected) showToast(`每次最多 20 個檔案，${rejected} 個未加入`, "error");
  $("#upload-input").value = "";
  renderUploadQueue();
}

function renderUploadQueue() {
  const body = $("#upload-queue-body");
  const fragment = document.createDocumentFragment();
  state.upload.queue.forEach((item, index) => {
    const row = make("tr");
    const name = make("td");
    const stack = make("span", "cell-stack");
    stack.append(make("strong", "", item.file.name));
    if (item.error) stack.append(make("small", "queue-error", item.error));
    else if (item.status === "success") stack.append(make("small", "", "上傳完成"));
    else if (item.status === "error") stack.append(make("small", "queue-error", item.error || "上傳失敗"));
    name.append(stack);
    const size = make("td", "", formatBytes(item.file.size));
    const extension = make("td", "", extensionOf(item.file.name) === "—" ? "—" : `.${extensionOf(item.file.name)}`);
    const action = make("td");
    const remove = make("button", "row-action", "×");
    remove.type = "button";
    remove.disabled = state.upload.active;
    remove.setAttribute("aria-label", `移除 ${item.file.name}`);
    remove.addEventListener("click", () => {
      state.upload.queue.splice(index, 1);
      renderUploadQueue();
    });
    action.append(remove);
    row.append(name, size, extension, action);
    fragment.append(row);
  });
  body.replaceChildren(fragment);
  $("#queue-count").textContent = String(state.upload.queue.length);
  $("#queue-placeholder").hidden = state.upload.queue.length > 0;
  $(".compact-table", $("#upload-modal")).hidden = state.upload.queue.length === 0;
  const retryable = state.upload.queue.some((item) => ["queued", "error"].includes(item.status));
  const invalid = state.upload.queue.some((item) => item.status === "invalid");
  $("#start-upload").disabled = state.upload.active || !retryable || invalid || !navigator.onLine;
  $("#start-upload").textContent = state.upload.queue.some((item) => item.status === "error") ? "重試失敗項目" : "開始上傳";
  $("#clear-queue").disabled = state.upload.active || state.upload.queue.length === 0;
}

function renderUploadProgress() {
  const host = $("#progress-list");
  const fragment = document.createDocumentFragment();
  state.upload.queue.forEach((item) => {
    const row = make("div", `progress-item${item.status === "success" ? " is-success" : item.status === "error" ? " is-error" : ""}`);
    row.append(make("span", "", item.file.name));
    let status = "等待中";
    if (item.status === "uploading") status = `${Math.min(100, Math.round((item.uploadedBytes / item.file.size) * 100))}%`;
    if (item.status === "processing") status = "正在寫入 Drive";
    if (item.status === "success") status = "完成 ✓";
    if (item.status === "error") status = item.error || "失敗";
    if (item.status === "invalid") status = "無法上傳";
    row.append(make("span", "", status));
    fragment.append(row);
  });
  host.replaceChildren(fragment);
}

function updateAggregateProgress(transferred, total) {
  const safeTotal = Math.max(1, total);
  const percent = Math.min(100, Math.round((transferred / safeTotal) * 100));
  $("#progress-percent").textContent = `${percent}%`;
  $("#overall-progress").style.width = `${percent}%`;
  if (state.upload.active) setSyncStatus(`上傳中 ${percent}%`, "online");
  const time = performance.now();
  state.upload.speedSamples.push({ time, bytes: transferred });
  state.upload.speedSamples = state.upload.speedSamples.filter((sample) => time - sample.time <= 3200);
  let speed = 0;
  if (state.upload.speedSamples.length > 1) {
    const first = state.upload.speedSamples[0];
    const seconds = (time - first.time) / 1000;
    if (seconds > 0) speed = (transferred - first.bytes) / seconds / 1024 / 1024;
  }
  $("#upload-speed").textContent = Number.isFinite(speed) && speed > 0 ? `${speed.toFixed(1)} MB/s` : "— MB/s";
}

function xhrPutChunk(uploadUrl, blob, start, total, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.timeout = 5 * 60 * 1000;
    xhr.setRequestHeader("Authorization", `Bearer ${state.accessToken}`);
    xhr.responseType = "json";
    xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
    xhr.setRequestHeader("Content-Range", `bytes ${start}-${start + blob.size - 1}/${total}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(start + event.loaded);
    };
    xhr.onerror = () => reject(Object.assign(new Error("網路中斷"), { retryable: true }));
    xhr.ontimeout = () => reject(Object.assign(new Error("上傳逾時"), { retryable: true }));
    xhr.onload = () => {
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range");
        const end = range?.match(/bytes=0-(\d+)/)?.[1];
        resolve({ done: false, nextOffset: end ? Number(end) + 1 : start + blob.size });
      } else if (xhr.status === 200 || xhr.status === 201) {
        resolve({ done: true, file: xhr.response || null });
      } else {
        const error = Object.assign(new Error(`Drive 上傳回應 ${xhr.status}`), {
          status: xhr.status,
          retryable: xhr.status >= 500 || xhr.status === 429,
        });
        reject(error);
      }
    };
    xhr.send(blob);
  });
}

function queryUploadOffset(uploadUrl, total) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.timeout = 30 * 1000;
    xhr.setRequestHeader("Authorization", `Bearer ${state.accessToken}`);
    xhr.setRequestHeader("Content-Range", `bytes */${total}`);
    xhr.onload = () => {
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range");
        const end = range?.match(/bytes=0-(\d+)/)?.[1];
        resolve(end ? Number(end) + 1 : null);
      } else if (xhr.status === 200 || xhr.status === 201) resolve(total);
      else reject(Object.assign(new Error(`無法查詢續傳位置 (${xhr.status})`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error("無法查詢續傳位置"));
    xhr.ontimeout = () => reject(new Error("查詢續傳位置逾時"));
    xhr.send(null);
  });
}

async function uploadFileInChunks(file, session, onProgress) {
  let offset = 0;
  let finalFile = null;
  const chunkSize = Number(session.chunkSizeBytes) || CONFIG.UPLOAD_CHUNK_BYTES;
  while (offset < file.size) {
    const chunkStart = offset;
    const end = Math.min(file.size, offset + chunkSize);
    const chunk = file.slice(offset, end, file.type || "application/octet-stream");
    let attempt = 0;
    while (true) {
      try {
        const result = await xhrPutChunk(session.uploadUrl, chunk, offset, file.size, onProgress);
        if (result.done) finalFile = result.file;
        offset = result.done ? file.size : result.nextOffset;
        break;
      } catch (error) {
        attempt += 1;
        if (!error.retryable || attempt > 3) throw error;
        await wait(Math.min(8000, 700 * 2 ** attempt + Math.random() * 350));
        try {
          const remoteOffset = await queryUploadOffset(session.uploadUrl, file.size);
          if (remoteOffset >= file.size) return finalFile;
          if (Number.isInteger(remoteOffset)) {
            offset = remoteOffset;
            break;
          }
          offset = chunkStart;
        } catch (queryError) {
          if (queryError.status === 404) throw new Error("續傳工作已過期，請重新上傳");
        }
      }
    }
  }
  return finalFile;
}

async function performUpload(file, kind, onProgress = () => {}, noteId = "") {
  if (DEMO_MODE) {
    for (let step = 1; step <= 12; step += 1) {
      await wait(55 + Math.random() * 40);
      onProgress(Math.round((file.size * step) / 12));
    }
    return { id: uid(), fileId: uid(), name: file.name, sizeBytes: file.size, mimeType: file.type };
  }
  const sessionResult = await api("/api/uploads/session", {
    method: "POST",
    body: JSON.stringify({
      clientKey: uid(),
      name: file.name,
      sizeBytes: file.size,
      mimeType: file.type || "application/octet-stream",
      kind,
      noteId: noteId || undefined,
    }),
  });
  const session = sessionResult.session || sessionResult.sessions?.[0] || sessionResult;
  if (!session.uploadUrl || !session.uploadId || !session.fileId) throw new Error("API 未回傳完整的可續傳工作");
  const driveFile = await uploadFileInChunks(file, session, onProgress);
  const finalized = await api(`/api/uploads/${encodeURIComponent(session.uploadId)}/finalize`, {
    method: "POST",
    body: JSON.stringify({
      fileId: driveFile?.id || session.fileId,
      finalizeToken: session.finalizeToken,
    }),
  });
  return finalized.file || finalized;
}

async function startUpload() {
  const candidates = state.upload.queue.filter((item) => ["queued", "error"].includes(item.status));
  if (!candidates.length || state.upload.active) return;
  if (!navigator.onLine) {
    showToast("目前離線，恢復網路後再開始上傳", "error");
    return;
  }
  state.upload.active = true;
  state.upload.transferredBytes = 0;
  state.upload.speedSamples = [];
  const total = candidates.reduce((sum, item) => sum + item.file.size, 0);
  let completedBefore = 0;
  $("#progress-section").hidden = false;
  $("#progress-label").textContent = "正在上傳，手機請保持程式在前景";
  updateAggregateProgress(0, total);
  renderUploadQueue();
  renderUploadProgress();
  window.addEventListener("beforeunload", preventUploadExit);

  for (const item of candidates) {
    item.status = "uploading";
    item.error = "";
    item.uploadedBytes = 0;
    renderUploadProgress();
    try {
      const uploaded = await performUpload(item.file, state.upload.kind, (loaded) => {
        item.uploadedBytes = loaded;
        state.upload.transferredBytes = completedBefore + loaded;
        updateAggregateProgress(state.upload.transferredBytes, total);
        renderUploadProgress();
      });
      item.status = "processing";
      renderUploadProgress();
      if (DEMO_MODE) {
        const objectUrl = URL.createObjectURL(item.file);
        const record = normalizeRecord({
          ...uploaded,
          id: uploaded.id,
          name: item.file.name,
          sizeBytes: item.file.size,
          mimeType: item.file.type,
          kind: state.upload.kind,
          createdTime: new Date().toISOString(),
          uploader: state.user
            ? { type: "google", displayName: state.user.name }
            : { type: "anonymous", displayName: "訪客", ipLabel: "展示 IP" },
          thumbnailUrl: state.upload.kind === "photo" ? objectUrl : "",
          contentUrl: objectUrl,
          permissions: { canRename: true, canDelete: true, canCopy: true },
        });
        if (state.upload.kind === "photo") state.photos.unshift(record);
        else state.files.unshift(record);
      }
      item.status = "success";
      item.uploadedBytes = item.file.size;
      completedBefore += item.file.size;
      updateAggregateProgress(completedBefore, total);
    } catch (error) {
      item.status = "error";
      item.error = error.message;
      completedBefore += item.uploadedBytes;
    }
    renderUploadProgress();
  }

  state.upload.active = false;
  window.removeEventListener("beforeunload", preventUploadExit);
  const failures = state.upload.queue.filter((item) => item.status === "error");
  if (failures.length) {
    $("#progress-label").textContent = `${failures.length} 個檔案失敗，可按下方按鈕重試`;
    $("#upload-modal-note").textContent = "成功項目已寫入 Drive；失敗項目仍留在清單內。";
    setSyncStatus("部分上傳失敗", "offline");
    renderUploadQueue();
    showToast("部分檔案上傳失敗，視窗會保持開啟", "error");
    return;
  }

  updateAggregateProgress(total, total);
  $("#upload-speed").textContent = "完成";
  setSyncStatus("上傳完成", "online");
  renderUploadQueue();
  if (state.upload.kind === "photo") {
    state.photosLoaded = false;
    void loadPhotos(true);
  } else {
    state.filesLoaded = false;
    void loadFiles(true);
  }
  for (let seconds = 5; seconds >= 1; seconds -= 1) {
    if ($("#upload-modal").hidden) {
      showToast("所有檔案已上傳完成");
      return;
    }
    $("#progress-label").textContent = `檔案上傳完成，${seconds} 秒後關閉`;
    await wait(1000);
  }
  if (!$("#upload-modal").hidden) closeModal($("#upload-modal"));
  showToast("所有檔案已上傳完成");
}

function preventUploadExit(event) {
  if (!state.upload.active) return;
  event.preventDefault();
  event.returnValue = "";
}

const SETTING_LABELS = {
  drive: "Drive API",
  upload: "上傳規則",
  auth: "帳戶登入",
  privacy: "權限隱私",
  appearance: "介面 PWA",
  version: "版本資訊",
};

function validSettingOrder() {
  const stored = readLocalJson("drivedock_setting_order", DEFAULT_SETTING_ORDER);
  if (!Array.isArray(stored)) return [...DEFAULT_SETTING_ORDER];
  const valid = stored.filter((id) => DEFAULT_SETTING_ORDER.includes(id));
  return valid.length === DEFAULT_SETTING_ORDER.length ? valid : [...DEFAULT_SETTING_ORDER];
}

function persistSettingOrder(order) {
  localStorage.setItem("drivedock_setting_order", JSON.stringify(order));
}

function reorderSettingsDom(order) {
  const stack = $("#settings-stack");
  order.forEach((id, index) => {
    const card = $(`[data-setting-id="${id}"]`, stack);
    if (!card) return;
    $(".setting-index", card).textContent = String(index + 1).padStart(2, "0");
    stack.append(card);
  });
}

function renderSettingsOrder() {
  const order = validSettingOrder();
  reorderSettingsDom(order);
  const host = $("#settings-order");
  const fragment = document.createDocumentFragment();
  order.forEach((id, index) => {
    const chip = make("div", "order-chip");
    chip.draggable = true;
    chip.dataset.settingId = id;
    chip.append(make("span", "", SETTING_LABELS[id]));
    const up = make("button", "", "↑");
    up.type = "button";
    up.disabled = index === 0;
    up.setAttribute("aria-label", `將${SETTING_LABELS[id]}上移`);
    up.addEventListener("click", () => {
      const next = validSettingOrder();
      const current = next.indexOf(id);
      [next[current - 1], next[current]] = [next[current], next[current - 1]];
      persistSettingOrder(next);
      renderSettingsOrder();
    });
    const down = make("button", "", "↓");
    down.type = "button";
    down.disabled = index === order.length - 1;
    down.setAttribute("aria-label", `將${SETTING_LABELS[id]}下移`);
    down.addEventListener("click", () => {
      const next = validSettingOrder();
      const current = next.indexOf(id);
      [next[current], next[current + 1]] = [next[current + 1], next[current]];
      persistSettingOrder(next);
      renderSettingsOrder();
    });
    chip.append(up, down);
    chip.addEventListener("dragstart", () => {
      state.draggedSetting = id;
      chip.classList.add("is-dragging");
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("is-dragging");
      delete state.draggedSetting;
      $$(".is-drag-target", host).forEach((node) => node.classList.remove("is-drag-target"));
    });
    chip.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (state.draggedSetting && state.draggedSetting !== id) chip.classList.add("is-drag-target");
    });
    chip.addEventListener("dragleave", () => chip.classList.remove("is-drag-target"));
    chip.addEventListener("drop", (event) => {
      event.preventDefault();
      const next = validSettingOrder();
      const from = next.indexOf(state.draggedSetting);
      const to = next.indexOf(id);
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        persistSettingOrder(next);
        renderSettingsOrder();
      }
    });
    fragment.append(chip);
  });
  host.replaceChildren(fragment);
}

function makeStatusRow(label, value) {
  const row = make("div");
  row.append(make("span", "", label), make("strong", "", value));
  return row;
}

function normalizeAdminSettings(raw = {}) {
  return {
    revision: 1,
    googleClientId: normalizeGoogleClientId(raw.googleClientId),
    folderInput: normalizeFolderInput(raw.folderInput || raw.folderId || raw.folderName),
    folderId: String(raw.folderId || "").trim(),
    folderName: String(raw.folderName || "").trim(),
    folderWebViewLink: String(raw.folderWebViewLink || "").trim(),
    driveId: String(raw.driveId || "").trim(),
    setupRequired: Boolean(raw.setupRequired),
    storageLocked: false,
  };
}

function setSetupFieldError(input, errorNode, message = "") {
  if (!input || !errorNode) return;
  const invalid = Boolean(message);
  input.setAttribute("aria-invalid", String(invalid));
  errorNode.textContent = message;
  errorNode.hidden = !invalid;
}

function clearGoogleSetupErrors() {
  setSetupFieldError($("#setup-client-id"), $("#setup-client-id-error"));
  setSetupFieldError($("#setup-folder-input"), $("#setup-folder-error"));
}

function validateGoogleSetup({ requireFolder = true } = {}) {
  clearGoogleSetupErrors();
  const clientInput = $("#setup-client-id");
  const folderInputNode = $("#setup-folder-input");
  const googleClientId = normalizeGoogleClientId(clientInput.value);
  const folderInput = normalizeFolderInput(folderInputNode.value);
  let firstInvalid = null;

  if (!isValidGoogleClientId(googleClientId)) {
    setSetupFieldError(clientInput, $("#setup-client-id-error"), "請輸入完整的 Google OAuth Web Client ID（結尾為 .apps.googleusercontent.com）。");
    firstInvalid = clientInput;
  }
  if (requireFolder && !folderInput) {
    setSetupFieldError(folderInputNode, $("#setup-folder-error"), "請輸入 Google Drive Folder ID、資料夾網址或名稱。");
    firstInvalid ||= folderInputNode;
  } else if (requireFolder && /^https?:\/\//i.test(folderInput) && !extractFolderId(folderInput)) {
    setSetupFieldError(folderInputNode, $("#setup-folder-error"), "請貼上有效的 Google Drive 資料夾網址。");
    firstInvalid ||= folderInputNode;
  } else if (requireFolder && !extractFolderId(folderInput) && (/[\p{Cc}\\/]/u.test(folderInput) || folderInput.length > 200)) {
    setSetupFieldError(folderInputNode, $("#setup-folder-error"), "資料夾名稱格式不正確。");
    firstInvalid ||= folderInputNode;
  }

  firstInvalid?.focus();
  return firstInvalid ? null : { googleClientId, folderInput };
}

function setGoogleSetupFeedback(stateName, label) {
  state.googleSetupFeedback = label ? { state: stateName, label } : null;
  const badge = $("#google-setup-state");
  if (!badge || !label) return;
  badge.dataset.state = stateName;
  badge.textContent = label;
}

function renderGoogleSetup() {
  const card = $("#google-setup-card");
  if (!card) return;
  const settings = state.adminSettings || normalizeAdminSettings({
    googleClientId: directSettings().googleClientId,
    folderInput: directSettings().folderInput,
    folderId: directSettings().folderId,
    folderName: directSettings().folderName,
    setupRequired: !directSettings().folderId,
  });
  const clientInput = $("#setup-client-id");
  const folderInput = $("#setup-folder-input");
  const saveButton = $("#save-google-setup");
  const loginButton = $("#bootstrap-google-login");
  const adminNote = $("#setup-admin-note");
  const online = navigator.onLine;

  $("#google-setup-form").setAttribute("aria-busy", String(state.googleSetupBusy));
  card.classList.toggle("is-admin", Boolean(state.user));
  card.classList.remove("is-readonly");
  clientInput.disabled = state.googleSetupBusy;
  folderInput.disabled = state.googleSetupBusy;
  saveButton.disabled = state.googleSetupBusy || !state.user || !online;
  loginButton.hidden = Boolean(state.user);
  loginButton.disabled = state.googleSetupBusy || !online;
  loginButton.textContent = "儲存設定並登入";
  saveButton.textContent = "驗證並儲存";

  if (!state.googleSetupDirty) {
    clientInput.value = settings.googleClientId || state.googleClientId || "";
    folderInput.value = settings.folderInput || settings.folderId || settings.folderName || "";
  }

  if (!online) {
    adminNote.textContent = "目前離線；恢復網路後才能登入及驗證 Google Drive 資料夾。";
  } else if (!state.user) {
    adminNote.textContent = "請填入 Client ID 與 Folder ID／資料夾網址，再按「儲存設定並登入」。存取權杖只保留在記憶體，不會寫入檔案或 localStorage。";
  } else if (!settings.folderId) {
    adminNote.textContent = "Google 已授權。請按「驗證並儲存」，確認目前帳戶可讀寫此資料夾。";
  } else {
    adminNote.textContent = `目前由 ${state.user.name} 直接連線 Google Drive；不需要 API 基礎網址或 Cloud Run。`;
  }

  $("#setup-folder-result").textContent = settings.folderName || (settings.folderId ? "已設定 Google Drive 資料夾" : "尚未設定");
  $("#setup-folder-id").textContent = settings.folderId
    ? `資料夾 ID：${maskDriveId(settings.folderId)}`
    : "可輸入 Folder ID、完整資料夾網址，或輸入名稱讓程式搜尋／建立。";

  const folderLink = safeDriveFolderLink(settings.folderWebViewLink, settings.folderId);
  const openFolder = $("#open-storage-folder");
  openFolder.hidden = !folderLink;
  if (folderLink) openFolder.href = folderLink;

  let badgeState = settings.folderId ? "success" : "idle";
  let badgeLabel = settings.folderId ? (state.user ? "已連線" : "待登入") : "待設定";
  if (state.googleSetupBusy) {
    badgeState = "checking";
    badgeLabel = "處理中";
  } else if (state.googleSetupFeedback) {
    badgeState = state.googleSetupFeedback.state;
    badgeLabel = state.googleSetupFeedback.label;
  }
  const badge = $("#google-setup-state");
  badge.dataset.state = badgeState;
  badge.textContent = badgeLabel;
}

function renderSettings() {
  renderSettingsOrder();
  const config = state.apiConfig || {};
  const settings = state.adminSettings || normalizeAdminSettings({
    googleClientId: directSettings().googleClientId,
    folderInput: directSettings().folderInput,
    folderId: directSettings().folderId,
    folderName: directSettings().folderName,
    setupRequired: !directSettings().folderId,
  });
  const driveStatus = $("#drive-status-list");
  driveStatus.replaceChildren(
    makeStatusRow("連線架構", "純前端 REST + CORS"),
    makeStatusRow("Google 帳戶", state.user?.email || "尚未授權"),
    makeStatusRow("目標資料夾", settings.folderName || "尚未設定"),
    ...(settings.folderId ? [makeStatusRow("資料夾 ID", maskDriveId(settings.folderId))] : []),
    makeStatusRow("分段大小", formatBytes(CONFIG.UPLOAD_CHUNK_BYTES, 0)),
  );
  $("#drive-setting-state").textContent = hasDriveSession() && settings.folderId ? "已連線" : settings.folderId ? "待登入" : "待設定";

  const privacy = $("#privacy-status-list");
  privacy.replaceChildren(
    makeStatusRow("API 基礎網址", "不需要"),
    makeStatusRow("Client Secret", "不使用、不可填入前端"),
    makeStatusRow("Access Token", "只存在記憶體，逾期後重新授權"),
    makeStatusRow("檔案權限", "依登入帳戶的 Google Drive 權限"),
  );
  $("#auth-setting-state").textContent = state.user ? "已授權" : "未登入";
  $("#overview-drive").textContent = hasDriveSession() && settings.folderId ? "已連線" : settings.folderId ? "待登入" : "待設定";
  $("#overview-auth").textContent = state.user ? "已授權" : "未登入";
  renderVersionInfo();
  $("#scan-storage").disabled = !hasDriveSession() || !settings.folderId || !navigator.onLine;
  $("#cleanup-storage").disabled = !hasDriveSession() || !settings.folderId || !navigator.onLine;
  renderGoogleSetup();
}

async function loadAdminSettings() {
  state.adminSettings = normalizeAdminSettings(await api("/api/admin/settings"));
  if (state.adminSettings.googleClientId) state.googleClientId = state.adminSettings.googleClientId;
  state.googleSetupDirty = false;
  renderSettings();
  return state.adminSettings;
}

async function scanStorageCandidates(notify = true) {
  const label = $("#storage-cleanup-result");
  if (!hasDriveSession() || !currentFolderId()) {
    showToast("請先登入 Google 並設定 Drive 資料夾", "error");
    return null;
  }
  try {
    const result = await api("/api/admin/storage");
    label.textContent = result.candidates.length
      ? `找到 ${result.candidates.length} 筆，共 ${formatBytes(result.totalBytes)}；可清理 7 天前資料。`
      : "沒有 7 天前未完成的上傳或孤兒附件。";
    if (notify) showToast(result.candidates.length ? `找到 ${result.candidates.length} 筆待整理資料` : "Drive 儲存狀態正常");
    return result;
  } catch (error) {
    label.textContent = `檢查失敗：${error.message}`;
    showToast(`無法檢查 Drive 儲存狀態：${error.message}`, "error");
    return null;
  }
}

async function cleanupStorageCandidates() {
  if (!hasDriveSession() || !currentFolderId()) return;
  if (!confirm("確定要把 7 天前未完成的上傳與孤兒附件移到 Google Drive 垃圾桶嗎？")) return;
  try {
    const result = await api("/api/admin/storage/cleanup", {
      method: "POST",
      body: JSON.stringify({ olderThanHours: 168 }),
    });
    const success = (result.results || []).filter((item) => item.success).length;
    showToast(`已清理 ${success} 筆 Drive 資料`);
    await scanStorageCandidates(false);
  } catch (error) {
    showToast(`清理失敗：${error.message}`, "error");
  }
}

async function loadPublicConfig() {
  state.apiConfig = await api("/api/config");
  const clientId = normalizeGoogleClientId(state.apiConfig.googleClientId);
  if (clientId) state.googleClientId = clientId;
  setSyncStatus(hasDriveSession() ? (currentFolderId() ? "Drive 已連線" : "請設定 Drive 資料夾") : "請登入 Google", hasDriveSession() ? "online" : "offline");
  renderSettings();
}

function bootstrapGoogleLogin() {
  const values = validateGoogleSetup({ requireFolder: true });
  if (!values) return;
  saveDirectSettings({
    googleClientId: values.googleClientId,
    folderInput: values.folderInput,
    folderId: extractFolderId(values.folderInput) || "",
    folderName: "",
  });
  state.googleClientId = values.googleClientId;
  state.pendingFolderInput = values.folderInput;
  state.googleSetupDirty = false;
  state.adminSettings = normalizeAdminSettings({
    googleClientId: values.googleClientId,
    folderInput: values.folderInput,
    folderId: extractFolderId(values.folderInput),
    setupRequired: true,
  });
  initializeGoogleSignIn(0, true);
  requestGoogleSignIn();
  renderSettings();
}

async function saveGoogleSetup(event) {
  event?.preventDefault?.();
  const values = validateGoogleSetup({ requireFolder: true });
  if (!values) return;
  if (!state.user || !hasDriveSession()) {
    bootstrapGoogleLogin();
    return;
  }
  state.googleSetupBusy = true;
  setGoogleSetupFeedback("checking", "驗證中");
  renderGoogleSetup();
  try {
    const result = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(values),
    });
    state.adminSettings = normalizeAdminSettings(result);
    state.googleClientId = result.googleClientId;
    state.apiConfig = {
      ...(state.apiConfig || {}),
      googleClientId: result.googleClientId,
      folderName: result.folderName,
      driveConfigured: true,
      setupRequired: false,
    };
    state.googleSetupDirty = false;
    clearGoogleSetupErrors();
    setGoogleSetupFeedback("success", "已連接");
    state.filesLoaded = false;
    state.photosLoaded = false;
    state.notesLoaded = false;
    await Promise.all([loadFiles(true), loadPhotos(true), loadNotes(true)]);
    showToast(`已連接「${result.folderName}」`);
  } catch (error) {
    setGoogleSetupFeedback("error", "驗證失敗");
    showToast(`無法儲存 Google Drive 設定：${error.message}`, "error");
  } finally {
    state.googleSetupBusy = false;
    renderSettings();
  }
}

function openModal(id, focusTarget = null) {
  const backdrop = typeof id === "string" ? document.getElementById(id) : id;
  if (!backdrop) return;
  state.lastModalFocus = document.activeElement;
  backdrop.hidden = false;
  document.body.classList.add("modal-open");
  requestAnimationFrame(() => {
    (focusTarget || $("button, input, textarea, [tabindex='0']", backdrop))?.focus?.();
  });
}

function closeModal(target) {
  const backdrop = typeof target === "string" ? document.getElementById(target) : target?.closest?.(".modal-backdrop") || target;
  if (!backdrop || backdrop.hidden) return;
  if (backdrop.id === "upload-modal" && state.upload.active) {
    if (!confirm("檔案仍在上傳中。關閉視窗後會在背景繼續，離開或關閉此頁仍會中斷；確定要關閉視窗嗎？")) return;
  }
  backdrop.hidden = true;
  if (!$(".modal-backdrop:not([hidden])")) document.body.classList.remove("modal-open");
  if (backdrop.id === "photo-viewer") {
    state.viewerPhoto = null;
    if (state.photoObjectUrl) URL.revokeObjectURL(state.photoObjectUrl);
    state.photoObjectUrl = "";
    $("#photo-viewer-image").removeAttribute("src");
  }
  const focus = state.upload.opener || state.lastModalFocus;
  state.upload.opener = null;
  focus?.focus?.();
}

function trapModalFocus(event) {
  if (event.key !== "Tab") return;
  const modal = event.currentTarget;
  const focusable = $$('button:not(:disabled):not([hidden]), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])', modal)
    .filter((node) => node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function showToast(message, type = "success") {
  $$(".toast", $("#toast-region")).forEach((entry) => {
    if (entry.dataset.message === message && entry.dataset.type === type) entry.remove();
  });
  const toast = make("div", `toast${type === "error" ? " is-error" : ""}`);
  toast.dataset.message = message;
  toast.dataset.type = type;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.append(make("span", "toast-icon", type === "error" ? "!" : "✓"));
  toast.append(make("span", "", message));
  const close = make("button", "", "×");
  close.type = "button";
  close.setAttribute("aria-label", "關閉通知");
  close.addEventListener("click", () => toast.remove());
  toast.append(close);
  $("#toast-region").append(toast);
  setTimeout(() => toast.remove(), type === "error" ? 6500 : 4200);
}

async function installApp() {
  if (!state.installPrompt) {
    showToast("iPhone/iPad 請用分享選單的「加入主畫面」；桌面或 Android 請使用瀏覽器安裝按鈕");
    return;
  }
  state.installPrompt.prompt();
  await state.installPrompt.userChoice;
  state.installPrompt = null;
  $("#install-button").hidden = true;
}

function wireDropTarget(target, onFiles) {
  ["dragenter", "dragover"].forEach((type) =>
    target.addEventListener(type, (event) => {
      event.preventDefault();
      target.classList.add("is-dragging");
    }),
  );
  ["dragleave", "drop"].forEach((type) =>
    target.addEventListener(type, (event) => {
      event.preventDefault();
      target.classList.remove("is-dragging");
    }),
  );
  target.addEventListener("drop", (event) => onFiles(event.dataTransfer?.files || []));
}

function initializeEvents() {
  window.addEventListener("hashchange", applyRoute);
  window.addEventListener("online", () => {
    updateOnlineStatus();
    renderUploadQueue();
    renderVersionInfo();
    void checkForAppUpdate({ manual: false, autoApply: true });
    showToast("網路已恢復");
  });
  window.addEventListener("offline", () => {
    updateOnlineStatus();
    renderUploadQueue();
    renderVersionInfo();
    showToast("目前離線，上傳與管理功能已暫停", "error");
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    $("#install-button").hidden = false;
  });
  document.addEventListener("paste", handlePaste);
  document.addEventListener("keydown", handleCopyShortcut);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const open = $(".modal-backdrop:not([hidden])");
      if (open) closeModal(open);
      closeAccountMenu();
    }
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#account-button, #account-menu")) closeAccountMenu();
  });

  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#setting-theme-toggle").addEventListener("click", toggleTheme);
  $("#account-button").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleAccountMenu();
  });
  $("#google-signin").addEventListener("click", requestGoogleSignIn);
  $("#google-signout").addEventListener("click", signOut);
  $("#install-button").addEventListener("click", installApp);
  $("#setting-install").addEventListener("click", installApp);
  $("#check-update").addEventListener("click", () => checkForAppUpdate({ manual: true, autoApply: false }));
  $("#apply-update").addEventListener("click", () => applyAppUpdate({ automatic: false }));
  $("#auto-update-toggle").addEventListener("change", (event) => {
    state.version.autoUpdate = event.target.checked;
    localStorage.setItem("drivedock_auto_update", JSON.stringify(state.version.autoUpdate));
    renderVersionInfo();
    showToast(state.version.autoUpdate ? "已開啟自動更新" : "已改為手動更新");
    if (state.version.autoUpdate && state.version.updateAvailable) void applyAppUpdate({ automatic: true });
  });
  $$('[data-setting-target]').forEach((button) => {
    button.addEventListener("click", () => {
      const card = $(`[data-setting-id="${button.dataset.settingTarget}"]`);
      if (!card) return;
      card.open = true;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => card.querySelector("summary")?.focus({ preventScroll: true }), 280);
    });
  });

  $$('[data-open-upload]').forEach((button) => button.addEventListener("click", () => openUpload(button.dataset.openUpload)));
  $("#file-dropzone").addEventListener("click", () => openUpload("file"));
  $("#file-dropzone").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openUpload("file");
    }
  });
  wireDropTarget($("#file-dropzone"), (files) => openUpload("file", [...files]));
  wireDropTarget($("#upload-picker"), addFilesToQueue);
  $("#upload-input").addEventListener("change", (event) => addFilesToQueue(event.target.files));
  $("#clear-queue").addEventListener("click", () => {
    state.upload.queue = [];
    renderUploadQueue();
  });
  $("#start-upload").addEventListener("click", startUpload);

  $("#file-search").addEventListener("input", (event) => {
    state.fileSearch = event.target.value;
    renderFiles();
  });
  $("#refresh-files").addEventListener("click", () => loadFiles(true));
  $("#delete-files").addEventListener("click", deleteSelectedFiles);
  $("#rename-form").addEventListener("submit", handleRename);

  $("#add-note").addEventListener("click", () => openNoteModal());
  $("#refresh-notes").addEventListener("click", () => loadNotes(true));
  $("#note-form").addEventListener("submit", handleNoteSubmit);
  $("#note-attachment-input").addEventListener("change", (event) => addNoteAttachments(event.target.files));

  $("#refresh-photos").addEventListener("click", () => loadPhotos(true));
  $("#delete-photos").addEventListener("click", deleteSelectedPhotos);
  $("#copy-photo").addEventListener("click", copyCurrentPhoto);
  $$('[data-photo-filter]').forEach((button) =>
    button.addEventListener("click", () => {
      state.photoFilter = button.dataset.photoFilter;
      $$('[data-photo-filter]').forEach((entry) => entry.classList.toggle("is-active", entry === button));
      renderPhotos();
    }),
  );

  $("#google-setup-form").addEventListener("submit", saveGoogleSetup);
  $("#bootstrap-google-login").addEventListener("click", bootstrapGoogleLogin);
  [$("#setup-client-id"), $("#setup-folder-input")].forEach((input) => {
    input.addEventListener("input", () => {
      state.googleSetupDirty = true;
      setGoogleSetupFeedback("checking", "尚未儲存");
      if (input.id === "setup-client-id") setSetupFieldError(input, $("#setup-client-id-error"));
      else setSetupFieldError(input, $("#setup-folder-error"));
      renderGoogleSetup();
    });
  });
  $("#scan-storage").addEventListener("click", () => scanStorageCandidates());
  $("#cleanup-storage").addEventListener("click", cleanupStorageCandidates);
  $$(".setting-card").forEach((details) => {
    const collapsed = readLocalJson("drivedock_setting_collapsed", []);
    if (collapsed.includes(details.dataset.settingId)) details.open = false;
    details.addEventListener("toggle", () => {
      const current = new Set(readLocalJson("drivedock_setting_collapsed", []));
      if (details.open) current.delete(details.dataset.settingId);
      else current.add(details.dataset.settingId);
      localStorage.setItem("drivedock_setting_collapsed", JSON.stringify([...current]));
    });
  });

  $$('[data-close-modal]').forEach((button) =>
    button.addEventListener("click", () => closeModal(button.closest(".modal-backdrop"))),
  );
  $$(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal(backdrop);
    });
    backdrop.addEventListener("keydown", trapModalFocus);
  });
}

async function initialize() {
  applyTheme(localStorage.getItem("drivedock_theme") || "dark", false);
  const hint = readLocalJson("drivedock_profile_hint", null);
  if (hint?.name) {
    $("#account-name").textContent = hint.name;
    $("#account-status").textContent = "正在恢復登入…";
  }
  initializeEvents();
  updateOnlineStatus();
  renderAccount();
  renderFiles();
  renderPhotos();
  renderNotes();
  renderSettings();
  applyRoute();
  await Promise.all([loadPublicConfig(), restoreSession()]);
  if (state.canManage) await loadAdminSettings();
  initializeGoogleSignIn();
  const setupNotice = sessionStorage.getItem("drivedock_setup_notice") || sessionStorage.getItem("drivedock_bootstrap_notice");
  if (setupNotice) {
    sessionStorage.removeItem("drivedock_setup_notice");
    sessionStorage.removeItem("drivedock_bootstrap_notice");
    showToast(setupNotice);
  }
  await registerServiceWorker();
  renderVersionInfo();
  const updateNotice = sessionStorage.getItem("drivedock_update_notice");
  if (updateNotice) {
    sessionStorage.removeItem("drivedock_update_notice");
    showToast(updateNotice);
  }
  await checkForAppUpdate({ manual: false, autoApply: true });
}

initialize();
