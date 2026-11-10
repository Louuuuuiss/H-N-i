# H-N-i 旅遊行程公版

這個靜態網站可作為不同國家的旅遊行程公版。公開頁面保留行程、景點、娛樂、美食與地圖；右上角登入後可編輯並儲存到 Cloudflare D1。

## 編輯內容

登入後可修改旅程名稱、日期、天數與旗幟；新增或刪除每日行程，新增日期會接續前一天，刪除日期後後續日期會順延。日期與每日行程項目都可拖曳排序，編輯每日行程時日期列及新增／刪除操作會固定在上方。管理景點、娛樂、美食的名稱、標籤、描述、連結及選填地圖座標。儲存後，所有訪客都會看到 D1 中最新的行程。

## Cloudflare 元件

- D1 資料庫：`hanoi-trip-db`
- Worker API：`hanoi-trip-editor-api`
- Worker 原始碼與設定：`worker/`
- 網頁編輯器：`editor.js`

登入密碼與簽章金鑰使用 Cloudflare Worker Secrets 設定，不放在公開的網頁原始碼中。更新密碼請在 Worker 設定新的 `ADMIN_PASSWORD` secret；`AUTH_SECRET` 用於登入嘗試限制，請保留為隨機機密值。Worker 僅接受來自本 GitHub Pages 網站的瀏覽器來源。

如需重新部署 Worker，於 `worker/` 目錄使用 Wrangler，並先套用 `schema.sql` 中尚未套用的 D1 結構。
