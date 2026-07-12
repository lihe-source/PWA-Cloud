# 雲匣 DriveDock v1.1

一套可安裝在手機與電腦的 PWA 檔案櫃。前端部署到 GitHub Pages，後端部署到 Google Cloud Run；檔案、相片、備註 JSON 與附件全部儲存在同一個 Google Drive 資料夾，並以 `appProperties` 分類，不需要建立很多子資料夾。

v1.1 可由網站管理員在「系統設定」頁輸入自己申請的 Google 登入 Web Client ID，以及要存放全站資料的 Google Drive 資料夾名稱、網址或 ID。設定完成後全站共用同一組值；一般使用者與匿名訪客不會各自選擇資料夾。

> 尚未填入 API 網址時，前端會進入展示模式。展示資料只留在目前裝置，不會寫入 Google Drive。

## 已完成的功能

- P0 檔案：多檔上傳、500 MB 單檔上限、8 MB 分段可續傳、每檔與整體進度、目前 MB/s、完成後 5 秒自動關閉。
- 檔案列表：名稱、上傳者／匿名 IP、大小、副檔名、時間；各欄排序；可拖曳或用鍵盤左右按鈕調整欄位；預設最新優先。
- 管理：上傳者可改自己的檔名；API 管理員可批次移到 Drive 垃圾桶。網站不做永久刪除，Drive 管理者仍可直接在 Drive 管理。
- P1 備註：標題、純文字內容、多附件、新增／檢視／作者編輯；備註存成 Drive JSON。
- P2 相片：多選上傳、響應式縮圖、批次選取、管理員刪除、燈箱；桌面可 `Ctrl/Cmd + V` 貼上圖片，燈箱內可 `Ctrl/Cmd + C` 複製圖片。
- P3 設定：管理員設定全站共用的 Google Web Client ID 與 Drive 資料夾；其他設定區塊可折疊及調整順序。
- 手機／桌機雙介面、預設 Dark、Light 切換、離線 app shell、PWA 安裝圖示與 maskable 圖示。
- Google Identity Services 登入，後端建立 30 天滑動式 HttpOnly 工作階段；Google ID token 不會永久存放在瀏覽器。

## 安全邊界：兩種 Google 身分用途不同

設定頁中的 **Google 登入 Web Client ID** 是公開識別碼，會由瀏覽器使用，也會由 `GET /api/config` 回傳；它只負責識別網站使用者，**不會授權網站存取 Google Drive**。

真正的 Drive 權限來自 Cloud Run runtime identity：

- 推薦路線：Cloud Run user-managed service account + Google Workspace Shared Drive。
- 個人 My Drive 備援：由後端持有擁有者 OAuth refresh token。

請勿在網站設定頁、`config.js`、GitHub repository 或 ZIP 中填入／保存以下任何資料：

- OAuth Client Secret
- Access Token 或 Refresh Token
- Service Account JSON key
- `SESSION_SIGNING_KEY`
- 管理員名單或其他私密資料

附圖中的 Client ID 與 Folder ID 都只是格式範例，不是本程式提供的共用帳號或憑證。每一位部署者必須在自己的 Google Cloud 專案申請 Web Client ID，並使用自己有權管理的 Drive／Shared Drive。

## 為什麼需要 Cloud Run

GitHub Pages 是純靜態網站，不能安全保存 Drive 憑證、可靠判定上傳 IP，或替匿名訪客寫入共用 Drive。500 MB 也超過 Cloud Run 一般 HTTP/1 請求的 32 MiB 上限，因此本專案採用：

```text
GitHub Pages PWA ── 小型 JSON API ──> Cloud Run ──> Drive API / Shared Drive
        └──────── 8 MB chunks 直接送往 Drive resumable session ────────┘
```

Cloud Run 只建立一次性的 Drive resumable session、驗證完成狀態與管理權限；大型檔案不經過 Cloud Run 記憶體。參考：[Drive resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads)、[Cloud Run quotas](https://docs.cloud.google.com/run/quotas)。

## 精簡檔案結構

前端與後端都放在根目錄，只有 GitHub Actions 使用必要的隱藏資料夾：

```text
index.html                 PWA 主畫面
styles.css                 手機／桌機、Dark／Light 介面
app.js                     所有前端功能
config.js                  公開 API 網址與選填的登入 Client ID 備援
sw.js                      離線 app shell
manifest.webmanifest       PWA 安裝資訊
icon-192.png               安裝圖示
icon-512.png               高解析圖示
icon-maskable-512.png      Android maskable 圖示
server.js                  Cloud Run / Drive API 後端
package.json               Node 依賴
Dockerfile                 Cloud Run 容器
.env.example               後端設定範本（沒有真實密鑰）
.github/workflows/         Pages 與 Cloud Run 自動部署
```

## 第一次部署

部署順序很重要：先讓 Cloud Run 具備 Drive runtime identity、Shared Drive 範圍、管理員名單與 session secret，再從網站設定頁保存 Web Client ID 與資料夾。

### 1. 建立 Google Cloud 專案

啟用 Cloud Run、Cloud Build、Artifact Registry、Secret Manager 與 Google Drive API：

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  drive.googleapis.com
```

建立專用的 Cloud Run runtime service account。不要下載 JSON key；Cloud Run 會透過 Application Default Credentials（ADC）使用這個服務身分。

### 2. 準備 Shared Drive

推薦使用 Google Workspace 的專用 Shared Drive：

1. 建立一個只供這份 DriveDock 部署使用的 Shared Drive。
2. 把 Cloud Run runtime service account email 加入 Shared Drive，角色選「Content manager」。
3. 記下 Shared Drive ID，部署 Cloud Run 時設為 `DRIVE_SHARED_DRIVE_ID`。
4. 目標資料夾可以先自行建立，也可以稍後讓管理員在設定頁輸入新名稱，由 API 自動建立在 Shared Drive 根目錄。

Service account 沒有 My Drive 儲存配額，建議把檔案放在 Shared Drive；Shared Drive API 呼叫也必須支援 `supportsAllDrives=true`。參考：[Shared Drive overview](https://developers.google.com/workspace/drive/api/guides/about-shareddrives)、[Shared Drive API support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)。

如果只有個人 Gmail／My Drive，必須使用專用真人帳戶完成 OAuth authorization-code 授權，並把 `DRIVE_OAUTH_CLIENT_ID`、`DRIVE_OAUTH_CLIENT_SECRET` 與 `DRIVE_OAUTH_REFRESH_TOKEN` 由 Secret Manager 注入 Cloud Run。這三項不是網站設定頁中的 Web Client ID 欄位；絕對不能貼到前端。

### 3. 預先設定管理員與 session secret

在管理員能開啟全站設定前，Cloud Run 必須先知道誰是管理員。至少設定以下其中一項：

- `ADMIN_GOOGLE_SUBS`：推薦；一或多個穩定的 Google `sub`，以逗號分隔。
- `ADMIN_EMAILS`：首次設定時的備援；一或多個 Google 驗證過的 email，以逗號分隔。取得 `sub` 後建議改用 `ADMIN_GOOGLE_SUBS`。

同時建立至少 32 bytes 的 `SESSION_SIGNING_KEY`。建議放入 Secret Manager，例如：

- `drivedock-session-signing-key`
- `drivedock-admin-subs`，或首次使用的 `drivedock-admin-emails`

Cloud Run runtime service account 必須能讀取要掛載的 secret：

```bash
gcloud secrets add-iam-policy-binding SECRET_NAME \
  --member="serviceAccount:YOUR_RUNTIME_SERVICE_ACCOUNT" \
  --role="roles/secretmanager.secretAccessor"
```

### 4. 部署 Cloud Run API

首次部署不必先填 `GOOGLE_WEB_CLIENT_ID` 或 `DRIVE_FOLDER_ID`。以下為 Shared Drive 路線的必要基礎設定：

```bash
gcloud run deploy drivedock-api \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --service-account YOUR_RUNTIME_SERVICE_ACCOUNT \
  --set-env-vars "PUBLIC_API_URL=https://api.example.com,ALLOWED_ORIGINS=https://app.example.com,DRIVE_SHARED_DRIVE_ID=YOUR_SHARED_DRIVE_ID,DRIVEDOCK_INSTANCE_ID=drivedock-main,ALLOW_ANONYMOUS_UPLOADS=true,PUBLIC_DOWNLOADS=true,IP_DISPLAY_MODE=masked,SESSION_SAME_SITE=lax" \
  --set-secrets "SESSION_SIGNING_KEY=drivedock-session-signing-key:latest,ADMIN_GOOGLE_SUBS=drivedock-admin-subs:latest"
```

`DRIVEDOCK_INSTANCE_ID` 用來區分同一個 Shared Drive 內的多份 DriveDock 部署；每份部署應使用不同且固定的值。只有一份部署時可省略，後端預設為 `drivedock`。

也可以在 GitHub 手動執行 `Deploy API to Cloud Run` workflow。它使用 Workload Identity Federation，不需要保存長期 service-account key。空白的選填 bootstrap 變數會被略過，不會組成無效的 `gcloud` 參數；但下列基礎值仍應先設定完整：

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `CLOUD_RUN_SERVICE_NAME`
- `GCP_RUNTIME_SERVICE_ACCOUNT`
- `APP_ORIGIN`
- `PUBLIC_API_URL`
- `DRIVE_SHARED_DRIVE_ID`
- `SESSION_SECRET_NAME`
- `ADMIN_SUBS_SECRET_NAME` 或 `ADMIN_EMAILS_SECRET_NAME`
- GitHub secrets：`GCP_WORKLOAD_IDENTITY_PROVIDER`、`GCP_DEPLOY_SERVICE_ACCOUNT`

`GOOGLE_WEB_CLIENT_ID`、`DRIVE_FOLDER_ID` 與 `DRIVEDOCK_INSTANCE_ID` repository variables 是選填。前兩項只作首次部署／既有部署的 bootstrap fallback；管理員在網站保存的共用設定會優先使用。

若直接使用 `github.io` + `run.app`，把 `SESSION_SAME_SITE` 設為 `none`；使用 `app.example.com` + `api.example.com` 同主網域時設為 `lax`。

### 5. 部署 GitHub Pages

在 GitHub repository 設定：

- Settings → Pages → Source 選 `GitHub Actions`。
- Repository variable `PUBLIC_API_URL`：Cloud Run API 的 HTTPS 網址，正式使用時必要。
- Repository variable `GOOGLE_WEB_CLIENT_ID`：選填的公開 bootstrap fallback；可以留空，稍後由管理員在設定頁輸入。

推送到 `main` 後，`Deploy PWA to GitHub Pages` workflow 只打包 9 個扁平前端檔案。變數留空時仍可發佈；若 `PUBLIC_API_URL` 為空，網站會停留在展示模式。

### 6. 在網站完成 v1.1 共用設定

1. 在 Google Cloud Console 建立 OAuth 2.0 **Web application** Client ID。
2. Authorized JavaScript origins 加入正式 PWA origin，例如 `https://app.example.com`；本機測試可另加 `http://localhost:8080`。
3. 開啟 PWA 的「系統設定」。若目前沒有 bootstrap Client ID，輸入自己的公開 Web Client ID，按「套用 Client ID 並登入」，再使用預先列在 `ADMIN_GOOGLE_SUBS`／`ADMIN_EMAILS` 的 Google 帳戶登入。
4. 在 Drive 欄位輸入以下任一種內容：
   - 資料夾名稱，例如 `DriveDock Storage`
   - `https://drive.google.com/drive/folders/...` 資料夾網址
   - Google Drive Folder ID
5. 儲存後重新載入網站；所有使用者與匿名訪客都會使用這組全站設定。

名稱搜尋限制在 Cloud Run runtime identity 能存取的 Drive 範圍內：

- 找不到同名資料夾時，API 會在 Shared Drive 根目錄建立它。
- 只找到一個時會驗證並使用它。
- 找到多個同名資料夾時會要求改貼網址或 ID，避免選錯。
- 一旦目標資料夾已有 DriveDock 資料，v1.1 會鎖定綁定並阻止直接切換。請先選好資料夾；目前沒有自動跨資料夾遷移功能。

後端會把非秘密的全站值保存為指定資料夾內的 `.drivedock-config.json`，因此檔案、相片、備註、附件與程式設定都維持在同一個扁平資料夾。伺服器端的實際結果是唯一依據：前端會讀取 `GET /api/config` 回傳的 `googleClientId`、`folderName`、`driveConfigured` 與 `setupRequired`。Drive 設定檔有值時會優先於 `GOOGLE_WEB_CLIENT_ID`／`DRIVE_FOLDER_ID` 環境變數 fallback。

### 7. 保持登入的重要網域設定

最可靠的配置是：

```text
app.example.com  → GitHub Pages
api.example.com  → Cloud Run custom domain / HTTPS Load Balancer
```

兩者共享相同主網域時使用 `SESSION_SAME_SITE=lax`，30 天 HttpOnly session 每次開啟會滑動更新。直接使用 `username.github.io` + `service.run.app` 時必須改為 `SESSION_SAME_SITE=none`；Safari／iOS 或封鎖第三方 Cookie 的瀏覽器仍可能拒絕保存，因此無法保證永遠不再登入。使用者主動登出、清除瀏覽資料或安全事件後也需要重新驗證。參考：[Sign in with Google integration](https://developers.google.com/identity/gsi/web/guides/integrate)。

## 重要環境變數

| 名稱 | 必要性 | 用途 |
| --- | --- | --- |
| `PUBLIC_API_URL` | 正式環境必要 | Cloud Run API 公開網址 |
| `ALLOWED_ORIGINS` | 正式環境必要 | 精確允許的 PWA origins，逗號分隔 |
| `DRIVE_SHARED_DRIVE_ID` | Shared Drive 路線必要 | 限制設定檔、資料夾搜尋及建立範圍 |
| `DRIVEDOCK_INSTANCE_ID` | 選填 | 同一 Shared Drive 內區分多份部署；預設 `drivedock` |
| `GOOGLE_WEB_CLIENT_ID` | 選填 fallback | 公開 GIS audience；網站共用設定優先 |
| `DRIVE_FOLDER_ID` | 選填 fallback | 既有目標資料夾 ID；網站共用設定優先 |
| `ADMIN_GOOGLE_SUBS` | 至少一種管理員來源 | API 管理員 allowlist |
| `ADMIN_EMAILS` | 至少一種管理員來源 | 首次設定的 verified email 備援 |
| `SESSION_SIGNING_KEY` | 必要密鑰 | 簽署 30 天工作階段與 finalize capability |
| `SETTINGS_CACHE_TTL_MS` | 選填 | 共用設定快取，預設 `15000`、最大 60000 ms |
| `MAX_FILE_BYTES` | 選填 | 預設 `524288000`（500 MiB） |
| `UPLOAD_CHUNK_BYTES` | 選填 | 預設 `8388608`（8 MiB） |
| `IP_DISPLAY_MODE` | 選填 | 預設 `masked`；不建議 `full` |

完整範本請看 `.env.example`。

## 權限與隱私

- 匿名訪客可上傳，但不能修改全站設定。設定 API 只接受後端驗證完成的管理員工作階段。
- 匿名 IP 由後端判定，公開列表預設只顯示遮罩值。IP 屬於個人資料，正式上線請加入隱私告知。
- 登入使用者可重新命名自己上傳的檔案與編輯自己的備註。
- 批次刪除只接受 API 管理員；前端按鈕不是安全邊界。
- 網站的「刪除」使用 Drive `trashed=true`，不做永久 `files.delete`。
- Drive resumable session URL 是短效 capability，回應使用 `Cache-Control: no-store`，程式不把它存入 localStorage。
- Resumable 與 finalize capability 最長保留 7 天；設定頁可讓管理員檢查未完成上傳與孤兒附件，並把逾期資料移到垃圾桶。
- HTML、SVG 與其他上傳內容下載時都經後端並用 attachment 處理；相片縮圖拒絕 SVG inline 顯示。
- Service Worker 只快取 app shell，不快取 API、登入資料或私人檔案。

公開匿名上傳仍有容量與惡意檔案風險。正式公開前建議加上 External HTTPS Load Balancer、Cloud Armor 分散式 rate limit、reCAPTCHA Enterprise、每日 bytes 配額、惡意檔案掃描與 pending 清理。參考：[Cloud Armor rate limiting](https://docs.cloud.google.com/armor/docs/rate-limiting-overview)。

## 本機預覽與檢查

前端不需要 build：

```bash
python -m http.server 8080
```

開啟 `http://localhost:8080`。尚未設定 API 網址時會使用展示模式。

後端需要 Node 20 以上：

```bash
npm install
npm run check
npm start
```

未完成 Web Client ID 或 Drive 資料夾設定時，`GET /api/health` 與前端仍可載入；需要 Drive 的 API 會回傳明確的尚未設定錯誤。

## PWA 圖示

原創圖示以「雲端容器、文件與上傳箭頭」組合，避免直接使用 Google Drive 商標。專案包含一般 192／512 圖示、maskable 512 圖示，以及 `icon-master.png` 原始高解析版本。
