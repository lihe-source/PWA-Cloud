const baseConfig = window.DRIVEDOCK_CONFIG || {};

function readLocalJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const localConnection = readLocalJson("drivedock_connection", {});
const CONFIG = Object.freeze({
  ...baseConfig,
  API_BASE_URL: String(localConnection.API_BASE_URL || baseConfig.API_BASE_URL || "").replace(/\/$/, ""),
  GOOGLE_CLIENT_ID: String(localConnection.GOOGLE_CLIENT_ID || baseConfig.GOOGLE_CLIENT_ID || ""),
  MAX_FILE_BYTES: Number(baseConfig.MAX_FILE_BYTES) || 524288000,
  UPLOAD_CHUNK_BYTES: Number(baseConfig.UPLOAD_CHUNK_BYTES) || 8388608,
});
const DEMO_MODE = !CONFIG.API_BASE_URL && CONFIG.DEMO_MODE_WHEN_UNCONFIGURED !== false;
const APP_ID = "drivedock";
const PHOTO_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/avif",
]);

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
      // Ignore malformed server values and fall back to the verified folder ID.
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
      type: uploader.type || raw.uploaderType || "anonymous",
      displayName: uploader.displayName || raw.uploaderName || raw.uploaderLabel || "訪客",
      ipLabel: uploader.ipLabel || raw.uploaderIp || "—",
    },
    permissions: {
      canRename: Boolean(raw.permissions?.canRename ?? raw.canRename),
      canDelete: Boolean(raw.permissions?.canDelete ?? raw.canDelete),
      canCopy: raw.permissions?.canCopy !== false,
    },
    contentUrl: raw.contentUrl || apiUrl(`/api/files/${encodeURIComponent(id)}/content`),
    thumbnailUrl:
      raw.thumbnailUrl ||
      (normalizedKind === "photo" ? apiUrl(`/api/files/${encodeURIComponent(id)}/thumbnail`) : ""),
    webViewLink: raw.webViewLink || "",
  };
}

function apiUrl(path) {
  if (!CONFIG.API_BASE_URL) return path;
  return `${CONFIG.API_BASE_URL}${path}`;
}

async function api(path, options = {}) {
  if (DEMO_MODE) throw new Error("展示模式不會呼叫遠端 API");
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  headers.set("X-Requested-With", "DriveDock");
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(apiUrl(path), {
    ...options,
    headers,
    credentials: "include",
  });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("application/json") ? await response.json() : null;
  if (!response.ok && response.status !== 207) {
    const error = new Error(payload?.error?.message || payload?.message || `API 回應 ${response.status}`);
    error.code = payload?.error?.code || `HTTP_${response.status}`;
    error.status = response.status;
    error.retryable = Boolean(payload?.error?.retryable || response.status >= 500 || response.status === 429);
    throw error;
  }
  return payload?.data ?? payload ?? {};
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

const now = Date.now();
const demoFiles = [
  {
    id: "demo-file-1",
    name: "2026_品牌素材交付.zip",
    mimeType: "application/zip",
    sizeBytes: 84.62 * 1024 * 1024,
    createdTime: new Date(now - 8 * 60 * 1000).toISOString(),
    uploader: { type: "google", displayName: "林怡君" },
  },
  {
    id: "demo-file-2",
    name: "產品需求確認表.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    sizeBytes: 3.18 * 1024 * 1024,
    createdTime: new Date(now - 76 * 60 * 1000).toISOString(),
    uploader: { type: "anonymous", displayName: "訪客", ipLabel: "203.66.•••.•••" },
  },
  {
    id: "demo-file-3",
    name: "app-flow-v4.pdf",
    mimeType: "application/pdf",
    sizeBytes: 18.74 * 1024 * 1024,
    createdTime: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    uploader: { type: "google", displayName: "王小明" },
  },
  {
    id: "demo-file-4",
    name: "release-notes.txt",
    mimeType: "text/plain",
    sizeBytes: 0.08 * 1024 * 1024,
    createdTime: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    uploader: { type: "anonymous", displayName: "訪客", ipLabel: "114.32.•••.•••" },
  },
].map((file) =>
  normalizeRecord({ ...file, kind: "file", permissions: { canRename: true, canDelete: true } }),
);

const demoPhotos = [
  normalizeRecord({
    id: "demo-photo-1",
    name: "DriveDock-app-icon.png",
    kind: "photo",
    mimeType: "image/png",
    sizeBytes: 2.46 * 1024 * 1024,
    createdTime: new Date(now - 34 * 60 * 1000).toISOString(),
    uploader: { type: "google", displayName: "設計團隊" },
    thumbnailUrl: "./icon-512.png",
    contentUrl: "./icon-512.png",
    permissions: { canRename: true, canDelete: true, canCopy: true },
  }),
];

const demoNotes = [
  {
    id: "demo-note-1",
    title: "手機版驗收重點",
    content: "請在 360px 寬度確認底部導覽、上傳視窗與相片雙欄縮圖。",
    createdTime: new Date(now - 45 * 60 * 1000).toISOString(),
    uploader: { type: "google", displayName: "林怡君" },
    attachments: [{ id: "a1", name: "mobile-checklist.pdf", sizeBytes: 1.2 * 1024 * 1024, contentUrl: "#" }],
    permissions: { canEdit: true, canDelete: true },
  },
  {
    id: "demo-note-2",
    title: "Cloud Run 環境變數待補",
    content: "上線前設定 Shared Drive ID、資料夾 ID 與管理者 Google sub。",
    createdTime: new Date(now - 20 * 60 * 60 * 1000).toISOString(),
    uploader: { type: "anonymous", displayName: "訪客", ipLabel: "61.219.•••.•••" },
    attachments: [],
    permissions: { canEdit: true, canDelete: true },
  },
];

const FILE_COLUMNS = {
  name: { label: "檔案名稱", sortable: true },
  uploader: { label: "上傳者", sortable: true },
  sizeBytes: { label: "檔案大小 (MB)", sortable: true },
  extension: { label: "副檔名", sortable: true },
  createdTime: { label: "上傳時間", sortable: true },
};
const DEFAULT_COLUMN_ORDER = ["name", "uploader", "sizeBytes", "extension", "createdTime"];
const DEFAULT_SETTING_ORDER = ["connection", "drive", "upload", "auth", "privacy", "appearance", "version"];

const state = {
  route: "files",
  user: null,
  canManage: DEMO_MODE,
  files: DEMO_MODE ? [...demoFiles] : [],
  photos: DEMO_MODE ? [...demoPhotos] : [],
  notes: DEMO_MODE ? [...demoNotes] : [],
  filesLoaded: DEMO_MODE,
  photosLoaded: DEMO_MODE,
  notesLoaded: DEMO_MODE,
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
  installPrompt: null,
  apiConfig: null,
  adminSettings: null,
  googleClientId: CONFIG.GOOGLE_CLIENT_ID,
  googleSignInClientId: "",
  googleSetupBusy: false,
  googleSetupDirty: false,
  googleSetupFeedback: null,
  lastModalFocus: null,
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
  else if (DEMO_MODE) setSyncStatus("展示模式", "online");
  else if (state.apiConfig) setSyncStatus("Drive 已連線", "online");
  $("#scan-storage").disabled = !state.canManage || !online;
  $("#cleanup-storage").disabled = !state.canManage || !online;
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
    avatar.textContent = initials(user?.name || (DEMO_MODE ? "展" : "?"));
  }
  $("#account-name").textContent = user?.name || (DEMO_MODE ? "展示模式" : "Google 帳戶");
  $("#account-status").textContent = user
    ? state.canManage
      ? "管理員已登入"
      : "Google 已登入"
    : DEMO_MODE
      ? "本機互動預覽"
      : "尚未登入";
  $("#google-signin").hidden = Boolean(user) || DEMO_MODE;
  $("#google-signout").hidden = !user;
  $("#auth-setting-state").textContent = user ? (state.canManage ? "管理員" : "已登入") : "未登入";
  $("#scan-storage").disabled = !state.canManage || !navigator.onLine;
  $("#cleanup-storage").disabled = !state.canManage || !navigator.onLine;
  renderGoogleSetup();
}

async function restoreSession() {
  if (DEMO_MODE) {
    renderAccount();
    return;
  }
  try {
    const session = await api("/api/auth/session");
    state.user = session.authenticated ? session.user : null;
    state.canManage = Boolean(session.role === "admin" || session.canManage);
    if (state.user) localStorage.setItem("drivedock_profile_hint", JSON.stringify({ name: state.user.name }));
    else localStorage.removeItem("drivedock_profile_hint");
    renderAccount();
  } catch (error) {
    state.user = null;
    state.canManage = false;
    renderAccount();
    showToast(`登入狀態確認失敗：${error.message}`, "error");
  }
}

async function handleGoogleCredential(response) {
  try {
    const clientId = normalizeGoogleClientId(state.googleClientId || CONFIG.GOOGLE_CLIENT_ID);
    if (!clientId) throw new Error("尚未設定 Google Web Client ID");
    const session = await api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential: response.credential, clientId }),
    });
    state.user = session.user;
    state.canManage = session.role === "admin" || Boolean(session.canManage);
    localStorage.setItem("drivedock_profile_hint", JSON.stringify({ name: state.user?.name || "Google 使用者" }));
    renderAccount();
    closeAccountMenu();
    showToast(`歡迎回來，${state.user?.name || "Google 使用者"}`);
    await Promise.all([
      loadFiles(true),
      loadPhotos(true),
      loadNotes(true),
      state.canManage ? loadAdminSettings() : Promise.resolve(),
    ]);
    renderSettings();
  } catch (error) {
    showToast(`Google 登入失敗：${error.message}`, "error");
  }
}

function initializeGoogleSignIn(attempt = 0, force = false) {
  const clientId = normalizeGoogleClientId(state.googleClientId || CONFIG.GOOGLE_CLIENT_ID);
  if (DEMO_MODE || !clientId) return;
  if (!globalThis.google?.accounts?.id) {
    if (attempt < 40) setTimeout(() => initializeGoogleSignIn(attempt + 1, force), 250);
    return;
  }
  if (!force && state.googleSignInClientId === clientId) return;
  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleGoogleCredential,
    auto_select: true,
    cancel_on_tap_outside: false,
    use_fedcm_for_prompt: true,
  });
  const host = $("#google-button-host");
  host.replaceChildren();
  host.hidden = false;
  $("#account-menu").prepend(host);
  google.accounts.id.renderButton(host, {
    type: "standard",
    theme: document.documentElement.dataset.theme === "dark" ? "filled_black" : "outline",
    size: "large",
    width: 194,
    text: "signin_with",
    shape: "rectangular",
  });
  state.googleSignInClientId = clientId;
  $("#google-signin").hidden = true;
  if (!state.user) google.accounts.id.prompt();
}

function requestGoogleSignIn() {
  const clientId = normalizeGoogleClientId(state.googleClientId || CONFIG.GOOGLE_CLIENT_ID);
  if (DEMO_MODE || !clientId) {
    location.hash = "#settings";
    showToast("請先在設定頁套用有效的 Google Web Client ID", "error");
    return;
  }
  if (!globalThis.google?.accounts?.id) {
    showToast("Google 登入服務尚未載入，請稍後重試", "error");
    return;
  }
  google.accounts.id.prompt((notification) => {
    if (notification.isNotDisplayed?.() || notification.isSkippedMoment?.()) {
      showToast("請使用帳戶選單中的 Google 登入按鈕", "error");
    }
  });
}

async function signOut() {
  try {
    if (!DEMO_MODE) await api("/api/auth/logout", { method: "POST", body: "{}" });
    globalThis.google?.accounts?.id?.disableAutoSelect?.();
    state.user = null;
    state.canManage = DEMO_MODE;
    state.adminSettings = null;
    state.googleSetupDirty = false;
    localStorage.removeItem("drivedock_profile_hint");
    renderAccount();
    renderSettings();
    closeAccountMenu();
    showToast("已從此裝置登出");
    await Promise.all([loadFiles(true), loadPhotos(true), loadNotes(true)]);
  } catch (error) {
    showToast(`登出失敗：${error.message}`, "error");
  }
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
  $("#file-empty").hidden = records.length > 0;
  $("#file-table").hidden = records.length === 0;
  $("#selected-file-count").textContent = String(state.selectedFiles.size);
  $("#delete-files").disabled = state.selectedFiles.size === 0 || !state.canManage || !navigator.onLine;
  $("#file-permission-note").lastElementChild.textContent = state.canManage
    ? "您是 API 管理員，可重新命名並將已選檔案移到 Drive 垃圾桶。"
    : "只有檔案上傳者可重新命名；批次刪除只開放 API 管理員，Drive 擁有者仍可在 Drive 管理。";
}

async function loadFiles(force = false) {
  if (DEMO_MODE) {
    renderFiles();
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
  const grid = $("#photo-grid");
  const photos = visiblePhotos();
  const fragment = document.createDocumentFragment();
  photos.forEach((photo) => {
    const card = make("article", `photo-card${state.selectedPhotos.has(photo.id) ? " is-selected" : ""}`);
    const selector = make("label", "photo-select");
    const checkbox = make("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedPhotos.has(photo.id);
    checkbox.setAttribute("aria-label", `選取 ${photo.name}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedPhotos.add(photo.id);
      else state.selectedPhotos.delete(photo.id);
      renderPhotos();
    });
    selector.append(checkbox);

    const open = make("button", "photo-open");
    open.type = "button";
    open.setAttribute("aria-label", `開啟 ${photo.name}`);
    const image = make("img");
    image.src = photo.thumbnailUrl || photo.contentUrl || "./icon-512.png";
    image.alt = photo.name;
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("error", () => {
      if (!image.src.endsWith("icon-512.png")) image.src = "./icon-512.png";
    });
    open.append(image);
    open.addEventListener("click", () => openPhotoViewer(photo));

    const meta = make("div", "photo-meta");
    meta.append(make("strong", "", photo.name));
    const line = make("div", "photo-meta-line");
    const uploader = make("span", "photo-uploader");
    uploader.append(make("span", "mini-avatar", initials(uploaderLabel(photo))));
    uploader.append(make("span", "", uploaderLabel(photo)));
    line.append(uploader);
    line.append(make("span", "", `${formatDate(photo.createdTime, false)} · ${formatBytes(photo.sizeBytes)}`));
    meta.append(line);
    card.append(selector, open, meta);
    fragment.append(card);
  });
  grid.replaceChildren(fragment);
  $("#photo-empty").hidden = photos.length > 0;
  $("#selected-photo-count").textContent = String(state.selectedPhotos.size);
  $("#delete-photos").disabled = state.selectedPhotos.size === 0 || !state.canManage || !navigator.onLine;
}

async function loadPhotos(force = false) {
  if (DEMO_MODE) {
    renderPhotos();
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
  image.src = photo.contentUrl || photo.thumbnailUrl;
  image.alt = photo.name;
  openModal("photo-viewer", $("#copy-photo"));
}

async function copyCurrentPhoto() {
  const photo = state.viewerPhoto;
  if (!photo) return;
  if (!globalThis.ClipboardItem || !navigator.clipboard?.write) {
    showToast("這個瀏覽器不支援直接複製圖片，請長按或另存圖片", "error");
    return;
  }
  try {
    const response = await fetch(photo.contentUrl || photo.thumbnailUrl, { credentials: "include" });
    if (!response.ok) throw new Error(`圖片回應 ${response.status}`);
    let blob = await response.blob();
    if (!blob.type.startsWith("image/")) blob = blob.slice(0, blob.size, photo.mimeType || "image/png");
    if (blob.type !== "image/png") {
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      bitmap.close?.();
      blob = await new Promise((resolve, reject) =>
        canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("無法轉換為 PNG"))), "image/png"),
      );
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    showToast("圖片已複製到剪貼簿");
  } catch (error) {
    showToast(`無法複製圖片：${error.message}`, "error");
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
      contentUrl: attachment.contentUrl || apiUrl(`/api/files/${encodeURIComponent(attachment.id)}/content`),
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
  if (DEMO_MODE) {
    state.notes = state.notes.map(normalizeNote);
    renderNotes();
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
    state.photosLoaded = DEMO_MODE;
    void loadPhotos(true);
  } else {
    state.filesLoaded = DEMO_MODE;
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
  connection: "前端連線",
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
  const revision = raw.revision === null || raw.revision === undefined ? null : Number(raw.revision);
  return {
    revision: Number.isFinite(revision) ? revision : null,
    googleClientId: normalizeGoogleClientId(raw.googleClientId),
    folderId: String(raw.folderId || "").trim(),
    folderName: String(raw.folderName || "").trim(),
    folderWebViewLink: String(raw.folderWebViewLink || "").trim(),
    driveId: String(raw.driveId || "").trim(),
    setupRequired: Boolean(raw.setupRequired),
    storageLocked: Boolean(raw.storageLocked),
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
    setSetupFieldError(clientInput, $("#setup-client-id-error"), "請輸入有效的 Google Web Client ID（結尾必須是 .apps.googleusercontent.com）。");
    firstInvalid = clientInput;
  }

  if (requireFolder) {
    let folderError = "";
    if (!folderInput) {
      folderError = "請輸入資料夾名稱、Google Drive 資料夾網址或 ID。";
    } else if (/^https?:\/\//i.test(folderInput)) {
      try {
        const url = new URL(folderInput);
        const isDriveHost = url.hostname.toLowerCase() === "drive.google.com";
        const hasFolderId = /\/folders\/[a-z0-9_-]{10,}/i.test(url.pathname) || /^[a-z0-9_-]{10,}$/i.test(url.searchParams.get("id") || "");
        if (url.protocol !== "https:" || !isDriveHost || !hasFolderId) {
          folderError = "請貼上有效的 HTTPS Google Drive 資料夾網址。";
        }
      } catch {
        folderError = "資料夾網址格式不正確。";
      }
    } else if (!/^[a-z0-9_-]{20,200}$/i.test(folderInput) && /[\p{Cc}\\/]/u.test(folderInput)) {
      folderError = "資料夾名稱不可包含斜線或控制字元。";
    } else if (!/^[a-z0-9_-]{20,200}$/i.test(folderInput) && folderInput.length > 200) {
      folderError = "資料夾名稱不可超過 200 個字元。";
    }
    if (folderError) {
      setSetupFieldError(folderInputNode, $("#setup-folder-error"), folderError);
      firstInvalid ||= folderInputNode;
    }
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

function clearPublishedBootstrapClientId() {
  const current = readLocalJson("drivedock_connection", {});
  if (!current.GOOGLE_CLIENT_ID) return;
  const next = {};
  if (current.API_BASE_URL) next.API_BASE_URL = String(current.API_BASE_URL).replace(/\/$/, "");
  if (Object.keys(next).length) localStorage.setItem("drivedock_connection", JSON.stringify(next));
  else localStorage.removeItem("drivedock_connection");
}

function renderGoogleSetup() {
  const card = $("#google-setup-card");
  if (!card) return;
  const publicConfig = state.apiConfig || {};
  const adminSettings = state.adminSettings || {};
  const publishedClientId = normalizeGoogleClientId(publicConfig.googleClientId);
  const clientId = normalizeGoogleClientId(adminSettings.googleClientId || publishedClientId || state.googleClientId || CONFIG.GOOGLE_CLIENT_ID);
  const folderName = String(adminSettings.folderName || publicConfig.folderName || "").trim();
  const folderId = String(adminSettings.folderId || "").trim();
  const configured = Boolean(adminSettings.folderId || publicConfig.driveConfigured || (folderName && publicConfig.setupRequired === false));
  const setupRequired = Boolean(adminSettings.setupRequired ?? publicConfig.setupRequired ?? !configured);
  const online = navigator.onLine;
  const canEdit = Boolean(state.canManage && !DEMO_MODE);
  const canBootstrap = Boolean(!DEMO_MODE && !state.user && !publishedClientId);
  const clientInput = $("#setup-client-id");
  const folderInput = $("#setup-folder-input");
  const saveButton = $("#save-google-setup");
  const bootstrapButton = $("#bootstrap-google-login");
  const adminNote = $("#setup-admin-note");

  $("#google-setup-form").setAttribute("aria-busy", String(state.googleSetupBusy));
  card.classList.toggle("is-admin", canEdit);
  card.classList.toggle("is-readonly", !canEdit);
  clientInput.disabled = state.googleSetupBusy || !(canEdit || canBootstrap);
  folderInput.disabled = state.googleSetupBusy || !canEdit || Boolean(adminSettings.storageLocked);
  saveButton.disabled = state.googleSetupBusy || !canEdit || !online;
  bootstrapButton.hidden = !canBootstrap;
  bootstrapButton.disabled = state.googleSetupBusy || !online;

  if (!state.googleSetupDirty || clientInput.disabled) {
    clientInput.value = clientId;
    folderInput.value = folderName;
  }

  if (DEMO_MODE) {
    adminNote.textContent = "目前是本機展示模式；請先在「前端連線」填入 API 網址，再進行全站設定。";
  } else if (adminSettings.storageLocked) {
    adminNote.textContent = "目前資料夾已有 DriveDock 資料，因此不能直接換綁；您仍可更新 Web Client ID，資料夾遷移需由伺服器端另行處理。";
  } else if (canEdit) {
    adminNote.textContent = "您以管理員身分編輯全站設定；儲存後，所有手機與電腦都會使用同一個 Drive 資料夾。";
  } else if (canBootstrap) {
    adminNote.textContent = "首次設定：先輸入公開的 Web Client ID，套用並登入管理員帳戶；登入後即可指定共用資料夾。";
  } else if (state.user) {
    adminNote.textContent = "目前登入帳戶不是 API 管理員，因此只能查看全站共用設定，不能變更。";
  } else {
    adminNote.textContent = "請先使用管理員 Google 帳戶登入；一般使用者只能查看共用資料夾狀態。";
  }

  $("#setup-folder-result").textContent = folderName || (setupRequired ? "尚未設定" : "已連接 Google Drive");
  $("#setup-folder-id").textContent = folderId
    ? `資料夾 ID：${maskDriveId(folderId)}`
    : configured
      ? "所有裝置共用此資料夾；完整 ID 僅對管理員顯示。"
      : "名稱不存在時會建立資料夾；若有同名資料夾，請貼網址或 ID。";

  const folderLink = safeDriveFolderLink(adminSettings.folderWebViewLink, folderId);
  const openFolder = $("#open-storage-folder");
  openFolder.hidden = !configured || !folderLink;
  if (folderLink) openFolder.href = folderLink;
  else openFolder.removeAttribute("href");

  let badgeState = configured ? "success" : "idle";
  let badgeLabel = configured ? "已連線" : setupRequired ? "待設定" : "尚未連接";
  if (state.googleSetupBusy) {
    badgeState = "checking";
    badgeLabel = "處理中";
  } else if (state.googleSetupFeedback) {
    badgeState = state.googleSetupFeedback.state;
    badgeLabel = state.googleSetupFeedback.label;
  } else if (DEMO_MODE) {
    badgeLabel = "展示模式";
  }
  const badge = $("#google-setup-state");
  badge.dataset.state = badgeState;
  badge.textContent = badgeLabel;
}

function renderSettings() {
  renderSettingsOrder();
  $("#setting-api-url").value = CONFIG.API_BASE_URL;
  $("#connection-setting-state").textContent = DEMO_MODE ? "展示模式" : CONFIG.API_BASE_URL ? "已設定" : "待設定";
  const driveStatus = $("#drive-status-list");
  const config = state.apiConfig || {};
  const adminSettings = state.adminSettings || {};
  const folderName = adminSettings.folderName || config.folderName || "";
  driveStatus.replaceChildren(
    makeStatusRow("API 狀態", DEMO_MODE ? "本機展示資料" : config.apiReady ? "正常" : "等待連線"),
    makeStatusRow("儲存模式", config.storageMode || (DEMO_MODE ? "尚未連接 Drive" : "由伺服器決定")),
    makeStatusRow("目標資料夾", folderName || (config.driveConfigured ? "已安全設定" : "尚未設定")),
    ...(adminSettings.folderId ? [makeStatusRow("資料夾 ID", maskDriveId(adminSettings.folderId))] : []),
    makeStatusRow("分段大小", formatBytes(config.uploadChunkBytes || CONFIG.UPLOAD_CHUNK_BYTES, 0)),
  );
  $("#drive-setting-state").textContent = config.driveConfigured ? "已連線" : DEMO_MODE ? "展示模式" : "待設定";
  const privacy = $("#privacy-status-list");
  privacy.replaceChildren(
    makeStatusRow("匿名上傳", config.anonymousUploads === false ? "停用" : "允許（建議加防機器人）"),
    makeStatusRow("訪客 IP", config.ipDisplayMode === "full" ? "完整顯示" : "預設遮罩"),
    makeStatusRow("網站刪除", "API 管理員移到垃圾桶"),
    makeStatusRow("公開下載", config.publicDownloads === false ? "停用" : "經後端串流"),
  );
  $("#auth-setting-state").textContent = state.user ? (state.canManage ? "管理員" : "已登入") : "未登入";
  $("#scan-storage").disabled = !state.canManage || !navigator.onLine;
  $("#cleanup-storage").disabled = !state.canManage || !navigator.onLine;
  renderGoogleSetup();
}

async function loadAdminSettings({ notify = false } = {}) {
  if (DEMO_MODE || !state.canManage || state.googleSetupBusy) return null;
  state.googleSetupBusy = true;
  setGoogleSetupFeedback("checking", "讀取中");
  renderGoogleSetup();
  try {
    const result = await api("/api/admin/settings");
    state.adminSettings = normalizeAdminSettings(result);
    if (state.adminSettings.googleClientId) state.googleClientId = state.adminSettings.googleClientId;
    state.googleSetupDirty = false;
    state.googleSetupFeedback = null;
    return state.adminSettings;
  } catch (error) {
    setGoogleSetupFeedback("error", "讀取失敗");
    if (notify || error.status !== 403) showToast(`無法讀取管理員設定：${error.message}`, "error");
    return null;
  } finally {
    state.googleSetupBusy = false;
    renderSettings();
  }
}

async function scanStorageCandidates(notify = true) {
  const label = $("#storage-cleanup-result");
  if (!state.canManage) {
    showToast("只有 API 管理員可以檢查未完成上傳", "error");
    return null;
  }
  try {
    const result = DEMO_MODE ? { candidates: [], totalBytes: 0 } : await api("/api/admin/storage");
    label.textContent = result.candidates.length
      ? `找到 ${result.candidates.length} 筆，共 ${formatBytes(result.totalBytes)}；可清理 7 天前資料。`
      : "沒有未完成上傳或孤兒附件。";
    if (notify) showToast(result.candidates.length ? `找到 ${result.candidates.length} 筆待整理資料` : "Drive 儲存狀態正常");
    return result;
  } catch (error) {
    label.textContent = `檢查失敗：${error.message}`;
    showToast(`無法檢查 Drive 儲存狀態：${error.message}`, "error");
    return null;
  }
}

async function cleanupStorageCandidates() {
  if (!state.canManage) return;
  if (!confirm("確定要把 7 天前未完成的上傳與孤兒附件移到 Drive 垃圾桶嗎？")) return;
  try {
    const result = DEMO_MODE
      ? { results: [] }
      : await api("/api/admin/storage/cleanup", {
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
  if (DEMO_MODE) {
    state.apiConfig = {
      apiReady: false,
      driveConfigured: false,
      googleClientId: state.googleClientId,
      folderName: "",
      setupRequired: true,
      storageMode: "展示模式",
      anonymousUploads: true,
      publicDownloads: true,
      ipDisplayMode: "masked",
      uploadChunkBytes: CONFIG.UPLOAD_CHUNK_BYTES,
    };
    setSyncStatus("展示模式", "online");
    renderSettings();
    return;
  }
  try {
    const previousClientId = normalizeGoogleClientId(state.googleClientId);
    state.apiConfig = await api("/api/config");
    const publishedClientId = normalizeGoogleClientId(state.apiConfig.googleClientId);
    if (publishedClientId) {
      state.googleClientId = publishedClientId;
      clearPublishedBootstrapClientId();
    }
    setSyncStatus(state.apiConfig.driveConfigured ? "Drive 已連線" : "API 已連線", "online");
    if (state.googleSignInClientId && publishedClientId && publishedClientId !== previousClientId) {
      initializeGoogleSignIn(0, true);
    }
  } catch (error) {
    state.apiConfig = null;
    setSyncStatus("API 連線失敗", "offline");
    showToast(`API 狀態檢查失敗：${error.message}`, "error");
  }
  renderSettings();
}

function bootstrapGoogleLogin() {
  if (DEMO_MODE) {
    showToast("請先設定 API 網址，再套用 Google Client ID", "error");
    return;
  }
  const values = validateGoogleSetup({ requireFolder: false });
  if (!values) return;
  const current = readLocalJson("drivedock_connection", {});
  const next = { GOOGLE_CLIENT_ID: values.googleClientId };
  if (current.API_BASE_URL) next.API_BASE_URL = String(current.API_BASE_URL).replace(/\/$/, "");
  localStorage.setItem("drivedock_connection", JSON.stringify(next));
  sessionStorage.setItem("drivedock_bootstrap_notice", "已套用公開 Client ID，請使用管理員 Google 帳戶登入。" );
  location.reload();
}

async function saveGoogleSetup(event) {
  event?.preventDefault?.();
  if (!state.canManage) {
    if (!state.user && !normalizeGoogleClientId(state.apiConfig?.googleClientId) && !DEMO_MODE) {
      bootstrapGoogleLogin();
      return;
    }
    showToast("只有 API 管理員可以變更全站 Google Drive 設定", "error");
    return;
  }
  if (!navigator.onLine) {
    showToast("目前離線，無法驗證並儲存 Drive 設定", "error");
    return;
  }
  const values = validateGoogleSetup();
  if (!values) return;
  const payload = {
    googleClientId: values.googleClientId,
    folderInput: values.folderInput,
  };
  const revision = state.adminSettings?.revision;
  if (Number.isFinite(revision)) payload.expectedRevision = revision;

  state.googleSetupBusy = true;
  setGoogleSetupFeedback("checking", "驗證中");
  renderGoogleSetup();
  try {
    const result = await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    state.adminSettings = normalizeAdminSettings(result);
    state.googleClientId = state.adminSettings.googleClientId || values.googleClientId;
    state.apiConfig = {
      ...(state.apiConfig || {}),
      googleClientId: state.googleClientId,
      folderName: state.adminSettings.folderName,
      driveConfigured: Boolean(state.adminSettings.folderId),
      setupRequired: state.adminSettings.setupRequired,
    };
    state.googleSetupDirty = false;
    clearGoogleSetupErrors();
    clearPublishedBootstrapClientId();
    setGoogleSetupFeedback("success", result.folderCreated ? "已建立並連線" : "已儲存並連線");
    showToast(result.folderCreated ? `已建立並連接「${state.adminSettings.folderName}」` : `已連接「${state.adminSettings.folderName}」`);
    if (result.reloadRequired) {
      sessionStorage.setItem("drivedock_setup_notice", "Google 與 Drive 共用設定已更新。" );
      setTimeout(() => location.reload(), 1200);
    } else {
      initializeGoogleSignIn(0, true);
      await Promise.all([loadFiles(true), loadPhotos(true), loadNotes(true)]);
    }
  } catch (error) {
    setGoogleSetupFeedback("error", error.status === 409 ? "設定已更新" : "驗證失敗");
    if (error.status === 409) setTimeout(() => void loadAdminSettings(), 0);
    showToast(`無法儲存 Google Drive 設定：${error.message}`, "error");
  } finally {
    state.googleSetupBusy = false;
    renderSettings();
  }
}

function saveLocalConnection() {
  const API_BASE_URL = $("#setting-api-url").value.trim().replace(/\/$/, "");
  if (API_BASE_URL && !/^https:\/\//i.test(API_BASE_URL) && !/^http:\/\/localhost(?::\d+)?$/i.test(API_BASE_URL)) {
    showToast("正式 API 網址必須使用 HTTPS", "error");
    return;
  }
  const current = readLocalJson("drivedock_connection", {});
  const next = {};
  if (API_BASE_URL) next.API_BASE_URL = API_BASE_URL;
  if (current.GOOGLE_CLIENT_ID) next.GOOGLE_CLIENT_ID = normalizeGoogleClientId(current.GOOGLE_CLIENT_ID);
  if (Object.keys(next).length) localStorage.setItem("drivedock_connection", JSON.stringify(next));
  else localStorage.removeItem("drivedock_connection");
  location.reload();
}

function resetLocalConnection() {
  const current = readLocalJson("drivedock_connection", {});
  const bootstrapClientId = normalizeGoogleClientId(current.GOOGLE_CLIENT_ID);
  if (bootstrapClientId) {
    localStorage.setItem("drivedock_connection", JSON.stringify({ GOOGLE_CLIENT_ID: bootstrapClientId }));
  } else {
    localStorage.removeItem("drivedock_connection");
  }
  location.reload();
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
  if (backdrop.id === "photo-viewer") state.viewerPhoto = null;
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
  const toast = make("div", `toast${type === "error" ? " is-error" : ""}`);
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
    showToast("網路已恢復");
  });
  window.addEventListener("offline", () => {
    updateOnlineStatus();
    renderUploadQueue();
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

  $("#save-local-connection").addEventListener("click", saveLocalConnection);
  $("#reset-local-connection").addEventListener("click", resetLocalConnection);
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
  if (hint?.name && !DEMO_MODE) {
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
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    } catch (error) {
      console.warn("Service worker registration failed", error);
    }
  }
}

initialize();
