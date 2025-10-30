# 劇場字幕機

這個專案提供一個含「控制端」與「檢視端」的劇場字幕機。控制端可以上傳劇本文字檔並呼叫 OpenAI 拆解成字幕句子、即時編輯與播放；檢視端僅顯示目前字幕，適合給觀眾或表演者在手機/平板上即時查看。

## 專案結構

```
server/  Node.js + Express + Socket.IO 後端服務
client/  Vite + React 控制端/檢視端前端
```

## 本地開發

1. 安裝依賴
   ```bash
   cd server && npm install
   cd ../client && npm install
   ```

2. 開啟開發伺服器
   - 後端：`cd server && npm run dev`（預設 http://localhost:3000）
   - 前端：另開一個終端 `cd client && npm run dev`（預設 http://localhost:5173）

   Vite dev server 已設定 proxy，開發時可直接造訪：
   - 控制端：http://localhost:5173/control
   - 檢視端：http://localhost:5173/viewer?session=場次ID

3. 若想以單一伺服器提供前端與 API：
   ```bash
   cd client && npm run build   # 建立前端靜態檔
   cd ../server && npm start    # 伺服器會自動提供 client/dist
   ```
   然後造訪 http://localhost:3000/control 。

## 使用流程（控制端）

1. 進入控制端頁面後，系統會建立新的場次並顯示對應的檢視端網址（格式為 `http://<host>:<port>/viewer?session=<場次ID>`）。
2. 於畫面左側輸入 OpenAI API Key（可以勾選「在此裝置記住」以存入瀏覽器 localStorage）。
3. 上傳 `.txt` 劇本文字檔並點選「使用 OpenAI 拆解字幕」，系統會呼叫 `gpt-4o-mini` 將台詞拆成適合字幕的句子，舞台指示與角色頭銜會被濾除。
4. 拆解完成後，右側會顯示完整字幕清單，可直接編輯（contentEditable）。點擊某一句或使用鍵盤方向鍵 `↑` / `↓` 會立即切換檢視端字幕。
5. 需要暫時關閉觀眾字幕時，點「遮蔽檢視端字幕」即可讓檢視端畫面變成空白，但控制端仍可瀏覽全文、以 `Command + F` 搜尋並點擊跳轉。

## 檢視端連線方式

- 將控制端畫面顯示的分享連結複製給觀眾或表演者，他們可在任何支援瀏覽器的裝置上開啟（建議橫式）。
- 檢視端只會建立單向連線接收字幕事件，無法反向控制或取得控制端資訊。
- 若要加入既有場次，可在控制端網址後加上 `?session=<場次ID>`；檢視端同樣使用該參數。

## 其他注意事項

- 後端以記憶體儲存字幕狀態，若伺服器重啟需重新上傳劇本。
- 為避免洩漏，控制端不會在伺服器保存 OpenAI Key；需於控制端畫面手動輸入。
- 若需要部署到雲端，請確保 3000 連接埠（或自訂）對控制端與檢視端裝置開放，並可依需求設定 HTTPS。
