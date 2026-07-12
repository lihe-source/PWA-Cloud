# 雲匣 DriveDock

一套可安裝在手機與電腦的 PWA 檔案櫃。前端部署到 GitHub Pages；後端部署到 Google Cloud Run；檔案、相片、備註 JSON 與附件全部儲存在同一個 Google Drive 資料夾，以 `appProperties` 分類，不需要建立很多子資料夾。

> 開箱時若 `config.js` 尚未填入 API 網址，畫面會進入「展示模式」，可以先操作排序、欄位拖曳、上傳流程、備註、相片與明暗模式。展示資料不會離開裝置，也不會真的寫入 Drive。

## 已完成的功能

- P0 檔案：多檔上傳、500 MB 單檔上限、8 MB 分段可續傳、每檔與整體進度、目前 MB/s、完成後 5 秒自動關閉。
- 檔案列表：名稱、上傳者／匿名 IP、大小、副檔名、時間；各欄排序；滑鼠拖曳或鍵盤左右按鈕調整欄位；預設最新優先。
- 管理：上傳者可改自己的檔名；API 管理員可批次移到 Drive 垃圾桶。網站不做永久刪除，Drive 擁有者仍可在 Drive 管理。
- P1 備註：標題、純文字內容、多附件、新增／檢視／作者編輯；備註存成 Drive JSON。
- P2 相片：多選上傳、響應式縮圖、批次選取、管理員刪除、燈箱；桌面可 `Ctrl/Cmd + V` 貼上圖片，燈箱內可 `Ctrl/Cmd + C` 複製圖片。
- P3 設定：前端連線、Drive、上傳、登入、權限隱私、PWA、版本等折疊區塊；可拖曳或用上下按鈕調整順序。
- 手機／桌機雙介面、預設 Dark、Light 切換、離線 app shell、PWA 安裝圖示與 maskable 圖示。
- Google Identity Services 登入，後端建立 30 天滑動式 HttpOnly 工作階段；不把 Google ID token 永久放在瀏覽器。

## 為什麼需要 Cloud Run

GitHub Pages 是純靜態網站，不能安全保存 Drive 憑證、可靠判定上傳 IP，或替匿名訪客寫入共用 Drive。500 MB 也超過 Cloud Run 一般 HTTP/1 請求的 32 MiB 上限，因此本專案採用：

```text
GitHub Pages PWA ── 小型 JSON API ──> Cloud Run ──> Drive API / Shared Drive
        └──────── 8 MB chunks 直接送往 Drive resumable session ────────┘
```

Cloud Run 只建立一次性的 Drive resumable session、驗證完成狀態與管理權限；大型檔案不經過 Cloud Run 記憶體。官方資料：[Drive resumable upload](https://developers.google.com/workspace/drive/api/guides/manage-uploads)、[Cloud Run quotas](https://docs.cloud.google.com/run/quotas)。

## 精簡檔案結構

前端與後端都放在根目錄，只有 GitHub Actions 使用必要的隱藏資料夾：

```text
index.html                 PWA 主畫面
styles.css                 手機／桌機、Dark／Light 介面
app.js                     所有前端功能
config.js                  可公開的 API 網址與 Google Client ID
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

## 第一次設定

### 1. 建立 Google Cloud 專案

在同一個專案啟用 Cloud Run、Cloud Build、Artifact Registry、Secret Manager 與 Google Drive API：

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com drive.googleapis.com
```

建立一個 Cloud Run runtime service account。不要下載 JSON key；Cloud Run 會使用 Application Default Credentials（ADC）。

### 2. 選擇 Drive 儲存方式

推薦 Google Workspace 的專用 Shared Drive：

1. 建立只給本程式使用的 Shared Drive。
2. 在其中建立一個資料夾，例如 `DriveDock`。
3. 把 Cloud Run runtime service account email 加入 Shared Drive，角色選「Content manager」。
4. 記下 Shared Drive ID 與資料夾 ID。

Service account 沒有 My Drive 儲存配額，官方建議它把檔案放在 Shared Drive；所有 Shared Drive API 呼叫也必須帶 `supportsAllDrives=true`。參考：[Shared Drive overview](https://developers.google.com/workspace/drive/api/guides/about-shareddrives)、[Shared Drive API support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives)。

如果只有個人 Gmail／My Drive，請改用一個專用真人帳戶完成一次 OAuth authorization-code 授權，將 `DRIVE_OAUTH_CLIENT_ID`、`DRIVE_OAUTH_CLIENT_SECRET` 與 `DRIVE_OAUTH_REFRESH_TOKEN` 放進 Secret Manager，再以環境變數注入 Cloud Run。絕對不能把 refresh token 放進 `config.js`、GitHub repo 或 ZIP。

### 3. 設定 Google 登入

在 Google Cloud Console 建立 OAuth 2.0 Web Client：

- Authorized JavaScript origins 加入正式 PWA 網址，例如 `https://app.example.com`。
- 本機測試可另加 `http://localhost:8080`。
- 將 Web Client ID 設為 GitHub repository variable `GOOGLE_WEB_CLIENT_ID`，也設為 Cloud Run 的 `GOOGLE_WEB_CLIENT_ID`。

登入只用來識別網站使用者；使用者不會取得 Drive 權限。所有 Drive 操作仍由 Cloud Run runtime identity 執行。

### 4. 建立 Cloud Run secrets

至少建立：

- `drivedock-session-signing-key`：32 bytes 以上的隨機值。
- `drivedock-admin-subs`：可刪除檔案的 Google `sub`，多個用逗號分隔。

首次設定若還不知道 `sub`，可暫時使用 `ADMIN_EMAILS`（後端只接受 Google 驗證為真的 email），之後再改為穩定的 `ADMIN_GOOGLE_SUBS`。

Cloud Run runtime service account 必須能讀取每個要掛載的 secret。請對上述兩個 secret（以及個人 My Drive 路線的 OAuth secrets）逐一授予：

```bash
gcloud secrets add-iam-policy-binding SECRET_NAME \
  --member="serviceAccount:YOUR_RUNTIME_SERVICE_ACCOUNT" \
  --role="roles/secretmanager.secretAccessor"
```

### 5. 部署 Cloud Run API

最簡單的首次部署方式：

```bash
gcloud run deploy drivedock-api \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --service-account YOUR_RUNTIME_SERVICE_ACCOUNT \
  --set-env-vars "PUBLIC_API_URL=https://api.example.com,ALLOWED_ORIGINS=https://app.example.com,GOOGLE_WEB_CLIENT_ID=YOUR_CLIENT_ID,DRIVE_SHARED_DRIVE_ID=YOUR_SHARED_DRIVE_ID,DRIVE_FOLDER_ID=YOUR_FOLDER_ID,ALLOW_ANONYMOUS_UPLOADS=true,PUBLIC_DOWNLOADS=true,IP_DISPLAY_MODE=masked,SESSION_SAME_SITE=lax" \
  --set-secrets "SESSION_SIGNING_KEY=drivedock-session-signing-key:latest,ADMIN_GOOGLE_SUBS=drivedock-admin-subs:latest"
```

也可在 GitHub 手動執行 `Deploy API to Cloud Run` workflow。它使用 Workload Identity Federation，不需要在 GitHub 保存長期 service-account key。此 workflow 預設是 Shared Drive 路線；先依 workflow 中的名稱設定 repository variables／secrets。若直接使用 `github.io` + `run.app`，repository variable `SESSION_SAME_SITE` 設為 `none`；使用同主網域的自訂網域時設為 `lax`。

個人 My Drive 路線需在首次部署另外把三項 OAuth 值從 Secret Manager 映射進 Cloud Run，例如：

```bash
gcloud run services update drivedock-api \
  --region asia-east1 \
  --update-env-vars "DRIVE_OAUTH_CLIENT_ID=YOUR_DRIVE_OAUTH_CLIENT_ID" \
  --update-secrets "DRIVE_OAUTH_CLIENT_SECRET=drivedock-drive-client-secret:latest,DRIVE_OAUTH_REFRESH_TOKEN=drivedock-drive-refresh-token:latest"
```

### 6. 部署 GitHub Pages

在 GitHub repository 設定：

- Settings → Pages → Source 選 `GitHub Actions`。
- Repository variable `PUBLIC_API_URL`：Cloud Run API 的 HTTPS 網址。
- Repository variable `GOOGLE_WEB_CLIENT_ID`：上一步的 Web Client ID。

推送到 `main` 後，`Deploy PWA to GitHub Pages` workflow 會只打包 9 個扁平前端檔案並發佈，不會把 `server.js`、環境範本或 secrets 發佈到 Pages。

### 7. 保持登入的重要網域設定

最可靠的配置是：

```text
app.example.com  → GitHub Pages
api.example.com  → Cloud Run custom domain / HTTPS Load Balancer
```

兩者共享相同主網域時，設定 `SESSION_SAME_SITE=lax`，30 天 HttpOnly session 每次開啟會滑動更新。若直接使用 `username.github.io` + `service.run.app`，兩者是跨站，必須改成 `SESSION_SAME_SITE=none`；Safari/iOS 或封鎖第三方 cookie 的瀏覽器仍可能拒絕保存，因此無法保證永遠不再登入。使用者主動登出、清除瀏覽資料、Google 撤銷授權或安全事件後，也一定需要重新驗證。GIS 的限制可參考：[Sign in with Google integration](https://developers.google.com/identity/gsi/web/guides/integrate)。

## 重要環境變數

| 名稱 | 是否公開 | 用途 |
| --- | --- | --- |
| `PUBLIC_API_URL` | 是 | Cloud Run API 公開網址 |
| `ALLOWED_ORIGINS` | 否 | 精確允許的 PWA origins |
| `GOOGLE_WEB_CLIENT_ID` | 是 | Google Identity Services audience |
| `DRIVE_SHARED_DRIVE_ID` | 不必公開 | Shared Drive ID |
| `DRIVE_FOLDER_ID` | 不必公開 | 唯一扁平資料夾 ID |
| `ADMIN_GOOGLE_SUBS` | 否 | API 管理員 allowlist |
| `SESSION_SIGNING_KEY` | 密鑰 | 簽署 30 天工作階段與 finalize capability |
| `MAX_FILE_BYTES` | 否 | 預設 `524288000`（500 MiB） |
| `UPLOAD_CHUNK_BYTES` | 否 | 預設 `8388608`（8 MiB） |
| `IP_DISPLAY_MODE` | 否 | 預設 `masked`；不建議 `full` |

完整範本請看 `.env.example`。

## 權限與隱私

- 匿名訪客可上傳；IP 由後端判定，公開列表預設只顯示遮罩值。IP 屬於個人資料，正式上線請加入隱私告知。
- 登入使用者可重新命名自己上傳的檔案與編輯自己的備註。
- 批次刪除只接受後端驗證後的管理員工作階段；前端按鈕不是安全邊界。
- 網站的「刪除」使用 Drive `trashed=true`，不做永久 `files.delete`。
- Drive resumable session URL 是短效 capability；後端加上 `Cache-Control: no-store`，程式不把它存入 localStorage。
- Resumable 與 finalize capability 最長保留 7 天；設定頁的 Drive 區塊可讓 API 管理員檢查未完成上傳與孤兒備註附件，並把 7 天前資料移到垃圾桶。
- HTML、SVG 與其他上傳內容下載時都經後端並用 attachment 處理；相片縮圖拒絕 SVG inline 顯示。
- Service Worker 只快取 app shell，不快取 API、登入資料或私人檔案。

公開匿名上傳仍有容量與惡意檔案風險。目前後端含每個執行個體的基本限流；正式公開前建議再加 External HTTPS Load Balancer + Cloud Armor 分散式 rate limit，以及 reCAPTCHA Enterprise、每日 bytes 配額、惡意檔案掃描與 24 小時 pending 清理。參考：[Cloud Armor rate limiting](https://docs.cloud.google.com/armor/docs/rate-limiting-overview)。

## 本機預覽與檢查

不需要前端 build：

```bash
python -m http.server 8080
```

開啟 `http://localhost:8080`。尚未設定 `config.js` 時會使用展示模式。

後端需要 Node 20 以上：

```bash
npm install
npm run check
npm start
```

沒有 Drive 設定時，`GET /api/health` 與前端展示仍可用；檔案 API 會明確回傳 `DRIVE_NOT_CONFIGURED`。

## PWA 圖示

原創圖示以「雲端容器、文件與上傳箭頭」組合，避免直接使用 Google Drive 商標。專案包含一般 192／512 圖示、maskable 512 圖示，以及 `icon-master.png` 原始高解析版本。
