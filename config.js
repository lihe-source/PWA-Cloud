/**
 * 雲匣 DriveDock 公開前端設定。
 *
 * 這個檔案會跟著 GitHub Pages 公開。Google OAuth Web Client ID 與
 * Drive Folder ID 可預先填入，也可由使用者在設定頁儲存在本機。
 * 請勿放入 Client Secret、Access Token、Refresh Token 或 Service Account JSON。
 */
window.DRIVEDOCK_CONFIG = Object.freeze({
  APP_NAME: "雲匣 DriveDock",
  GOOGLE_CLIENT_ID: "",
  DRIVE_FOLDER_ID: "",
  DRIVE_FOLDER_NAME: "",
  MAX_FILE_BYTES: 524288000,
  UPLOAD_CHUNK_BYTES: 8388608,
  VERSION: "2.7.0",
  BUILD_DATE: "2026-07-14",
  CACHE_NAME: "drivedock-v2.7.0",
});
