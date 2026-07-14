# 雲匣 DriveDock V1.9.0

> V1.9.0 將介面改為「雅致編輯」風格：以暖棕與米白為主色，Newsreader 用於標題與重點文字，Outfit 用於操作介面與內文。

DriveDock 是一套可安裝在 iPhone、Android 與桌面瀏覽器的 PWA 檔案櫃。V1.9.0 採用 **GitHub Pages 純前端架構**：使用 Google Identity Services 取得短效 Access Token，再由瀏覽器直接呼叫 Google Drive REST API。此版重點為暖棕米白的雅致編輯介面改版，並保留內網相容的 Blob 下載、相片卡片、iPhone 圖片複製與登入狀態恢復。

```text
GitHub Pages PWA
      ↓ Google OAuth Access Token
Google Drive API
      ↓
指定的 Drive Folder
```

不再需要：

- API 基礎網址
- Google Cloud Run
- `server.js`
- Client Secret
- Refresh Token
- Service Account JSON


## V1.9.0：雅致編輯介面


- 預設採暖棕、米白與紙張質感，建立雅致且沉穩的編輯風格。
- 標題、頁面主標與重點數字使用 Newsreader；按鈕、欄位、表格及內文使用 Outfit。
- 頁首、主視覺、摘要資訊、列表、設定卡片與手機底部導覽維持緊湊排版。
- 表格、相片卡片、按鈕、欄位、彈窗及明暗模式皆同步套用暖棕色視覺系統。

### 下載相容性
- 檔案、照片與備註附件不再以 `drive.google.com` 的 `webViewLink` 開啟。
- 使用目前登入帳戶的 OAuth Access Token 呼叫 Google Drive API `files/{id}?alt=media`。
- 將回應轉成瀏覽器 Blob，再透過 `URL.createObjectURL()` 與帶有 `download` 屬性的隱藏連結建立本機下載。
- 檔案表格提供獨立「下載」欄，檔名本身也可點擊下載。
- 相片卡片、相片預覽及備註附件均提供相同下載流程。
- 此方式仍需要內部網路允許 `www.googleapis.com`；它只避開被封鎖的 Google Drive 網頁網址。

## 主要功能

- 檔案、相片與備註列表使用固定標題列的可滾動表格。
- 多檔上傳，單檔上限 500 MB，8 MB 分段可續傳。
- 檔案重新命名、批次移到 Google Drive 垃圾桶。
- 相片預覽、篩選、批次刪除與 iPhone 相容的圖片複製。
- 備註以 JSON 檔案保存，可加入多個附件。
- 深色／淺色模式、PWA 安裝、離線 App Shell。
- 啟動時自動檢查版本，也可手動檢查及更新。
- 相容 V1.3.0／V1.4.0 使用相同 `appProperties` 建立的檔案、相片、備註與附件。
- 記住已登入帳號與尚未過期的短效授權；關閉 PWA 後可自動恢復。

## 檔案結構

```text
index.html
styles.css
app.js
config.js
sw.js
version.json
manifest.webmanifest
icon-192.png
icon-512.png
icon-maskable-512.png
package.json
.nojekyll
.github/workflows/pages.yml
README.md
```

## 一、建立 Google Cloud 專案

1. 進入 Google Cloud Console。
2. 建立或選擇一個專案。
3. 到「API 和服務 → 程式庫」。
4. 搜尋並啟用 **Google Drive API**。
5. 到「Google Auth Platform」完成 OAuth 同意畫面。
6. 若應用程式仍在 Testing 狀態，把實際使用者加入 Test users。

## 二、建立 OAuth Web Client ID

1. 到「Google Auth Platform → Clients」。
2. 建立 Client，類型選 **Web application**。
3. 在 Authorized JavaScript origins 加入 GitHub Pages 的 origin。

例如網站是：

```text
https://lihe-source.github.io/DriveDock/
```

Authorized JavaScript origin 只填：

```text
https://lihe-source.github.io
```

不要加入 Repository 路徑，也不要填 Client Secret。

建立後會取得：

```text
000000000000-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com
```

這就是設定頁要填的 **Google OAuth Web Client ID**。

## 三、取得 Google Drive Folder ID

在 Google Drive 建立一個專用資料夾，例如：

```text
DriveDock Storage
```

開啟該資料夾後，網址通常如下：

```text
https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz
```

`folders/` 後面的內容就是 Folder ID：

```text
1AbCdEfGhIjKlMnOpQrStUvWxYz
```

設定頁也接受完整資料夾網址，或直接輸入資料夾名稱。輸入名稱時，程式會搜尋同名資料夾；找不到時會在「我的雲端硬碟」建立。

## 四、部署到 GitHub Pages

### 手機上傳方式

1. 在 iPhone「檔案」App 解壓縮 ZIP。
2. 進入 GitHub Repository。
3. 點 **Add file → Upload files**。
4. 上傳解壓後資料夾內的所有檔案。
5. `.github/workflows/pages.yml` 必須保持相同資料夾結構。
6. Commit 到 `main`。
7. 到 Repository 的 **Settings → Pages**。
8. Source 選 **GitHub Actions**。
9. 等待 Actions 完成部署。

### 選填：以 GitHub Variables 預先填入設定

Repository：

```text
Settings
→ Secrets and variables
→ Actions
→ Variables
```

可新增：

| Variable | 用途 |
|---|---|
| `GOOGLE_WEB_CLIENT_ID` | 預先寫入公開 OAuth Client ID |
| `GOOGLE_DRIVE_FOLDER_ID` | 預先寫入 Drive Folder ID |

兩項都可留空。留空時，使用者可直接在 PWA 設定頁輸入。

## 五、第一次使用

1. 開啟已部署的 DriveDock。
2. 到「設定」。
3. 輸入完整 Google OAuth Web Client ID。
4. 輸入 Google Drive Folder ID、網址或名稱。
5. 按「儲存設定並登入」。
6. 選擇有權存取該資料夾的 Google 帳戶。
7. 同意 Google Drive 權限。
8. 成功後會顯示資料夾名稱與遮罩後的 Folder ID。

Client ID、Folder ID、已登入帳號與尚未過期的短效 Access Token 會儲存在目前裝置的瀏覽器儲存空間。重新開啟 PWA 時：

- 權杖仍有效：直接恢復 Google Drive 連線。
- 權杖已到期：保留帳號顯示，並在下一次使用者操作時自動嘗試取得新權杖。
- Google 或瀏覽器要求重新確認時，仍可能需要點一次授權；純前端網頁無法安全保存 Refresh Token。
- 只有按下「登出此裝置」時，才會清除已記住的帳號與本機授權資料。

## Google Drive 權限

V1.9.0 使用完整 Google Drive scope，才能直接存取使用者貼入的既有 Folder ID、共享資料夾及 V1.3.0 已建立的資料。Google OAuth 可能顯示較廣泛的 Drive 授權說明。

請確認：

- OAuth Client ID 是由自己建立或信任的管理者提供。
- Authorized JavaScript origin 是正確的 GitHub Pages 網域。
- 登入帳戶對指定資料夾具備足夠權限。
- 不要在前端輸入 Client Secret、Refresh Token 或 Access Token。

若資料夾分享給其他人，對方也必須：

1. 使用自己的 Google 帳戶登入 DriveDock。
2. 已取得該資料夾權限。
3. 使用同一個 Folder ID。

純前端版不支援匿名上傳。

## 相片複製

V1.9.0 的相片複製流程會：

1. 開啟預覽時，先使用目前 Google Access Token 從 Drive 讀取原始圖片。
2. 預先將圖片轉成 PNG，並暫存在記憶體快取。
3. 「複製」按鈕準備完成後，使用者點擊當下立即呼叫 Clipboard API，避免 iOS 因非同步等待而失去使用者授權。

必要條件：

- 網站使用 HTTPS；GitHub Pages 已符合。
- 瀏覽器支援 `ClipboardItem` 與圖片剪貼簿。
- 使用者必須由按鈕點擊觸發複製。

若 iOS 版本或目標 App 不支援圖片剪貼簿，仍可長按預覽圖片後使用系統的「拷貝」或「儲存到照片」。

## 版本更新

版本由下列檔案集中管理：

- `config.js`
- `version.json`
- `sw.js`
- `package.json`

目前版本：

```text
V1.9.0
```

程式啟動時會讀取 `version.json`。發現新版本時，會更新 Service Worker、清除舊的 DriveDock Cache Storage，並重新載入。

## 本機檢查

安裝 Node.js 20 以上版本後執行：

```bash
npm run check
```

此指令會檢查 `app.js` 與 `sw.js` 的 JavaScript 語法。

若要用本機 HTTP Server 測試：

```bash
python3 -m http.server 8080
```

並在 OAuth Client 的 Authorized JavaScript origins 加入：

```text
http://localhost:8080
```

不要直接以 `file://` 開啟 `index.html`，Google OAuth、Service Worker 與部分 PWA 功能無法正常運作。
