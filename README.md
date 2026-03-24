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

## 即時語音辨識（Realtime）接法

目前專案採用「Realtime WebSocket + 輸入音訊轉錄」模式：

1. 後端以 `wss://api.openai.com/v1/realtime?model=gpt-realtime` 建立連線。
2. 連線後送出 `session.update`，`session.type` 使用 `realtime`。
3. 轉錄設定放在 `session.audio.input.transcription`，可使用：
   - `gpt-4o-transcribe`
   - `gpt-4o-transcribe-latest`
   - `gpt-4o-mini-transcribe`
   - `gpt-4o-transcribe-diarize`
   - `whisper-1`
4. 音訊事件使用 `input_audio_buffer.append` 持續送 PCM16(24kHz, mono)。
5. 以前端 `conversation.item.input_audio_transcription.delta/completed` 顯示逐字稿。
6. 後端預設改用 `semantic_vad` 做語意切段，讓 Realtime API 依句意決定何時結束片段；控制端可取消勾選「開啟語意切段」改回手動 commit。
7. 語意切段模式下仍保留超時保底 `commit`，若約 2.2 秒都未切出新片段，後端會手動補一次 `commit`，避免長時間完全沒有字幕輸出。
8. 手動 commit 單一路徑仍可在關閉語意切段時使用（預設約 900ms 一段，且每段至少 400ms 音訊）。
9. 雙通道精修預設關閉，可由控制端勾選開啟；開啟後會在快通道完成後，以同段原始音訊做一次 `audio.transcriptions.create` 回填精修。
10. 控制端收音會保留雙聲道輸入並混成 mono，避免 `BlackHole 2ch` 或其他立體聲來源只吃到單邊聲道。
11. 當語言是 `zh`（或 `zh-*`）時，後端會做 OpenCC（簡轉繁，台灣用字）正規化，預設不送額外轉錄提示詞，避免提示詞內容誤出現在字幕。

可用環境變數微調即時性與穩定性（後端）：

- `TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED`：控制端未指定時，是否預設開啟語意切段（預設 `true`）。
- `TRANSCRIPTION_SEMANTIC_VAD_EAGERNESS`：語意切段速度，可選 `low` / `medium` / `high` / `auto`（預設 `high`）。
- `TRANSCRIPTION_SEMANTIC_FALLBACK_COMMIT_MS`：語意切段模式下，最長等待多久仍沒切段就強制補一次 `commit`（預設 `2200`）。
- `TRANSCRIPTION_FORCE_COMMIT_INTERVAL_MS`：commit 週期（預設 `900`）。
- `TRANSCRIPTION_MIN_COMMIT_AUDIO_MS`：最小音訊長度才 commit（預設 `400`）。
- `TRANSCRIPTION_COMMIT_COOLDOWN_MS`：兩次 commit 的最小間隔（預設 `500`）。
- `TRANSCRIPTION_DUAL_CHANNEL_ENABLED`：控制端未指定時的雙通道精修預設值（預設 `false`）。
- `TRANSCRIPTION_ACCURATE_MODEL`：二次音訊精修模型（預設 `gpt-4o-transcribe-latest`）。
- `TRANSCRIPTION_ACCURATE_PROMPT`：二次音訊精修用提示詞（選填）。
- `TRANSCRIPTION_ACCURATE_MIN_SEGMENT_MS`：二次精修最短片段長度（預設 `400`）。
- `TRANSCRIPTION_ACCURATE_MAX_SEGMENT_MS`：二次精修最長片段長度（預設 `8000`）。
- `TRANSCRIPTION_ACCURATE_MAX_PENDING_SEGMENTS`：等待對齊的音訊片段上限（預設 `40`）。
- `TRANSCRIPTION_TRADITIONAL_OUTPUT_ENABLED`：是否啟用繁體輸出保證（預設 `true`）。
- `TRANSCRIPTION_TRADITIONAL_OUTPUT_PROMPT`：自訂轉錄提示詞（選填，預設空值；若設定可能增加提示詞洩漏到字幕的風險）。

### 常見錯誤對照

- `Missing required parameter: 'session.type'.`
  - `session.update` 缺少 `session.type`。
- `Invalid value ... Supported values are ...`
  - 事件名稱或 payload 結構仍是舊版（例如舊的欄位位置）。
- `Passing a transcription session update event to a realtime session is not allowed.`
  - 連線是 realtime session，卻送了 transcription session 形狀。
- `Model "gpt-4o-mini-transcribe" is not supported in Realtime API`
  - 通常是把轉錄模型誤當成 WebSocket 連線模型（query `model=`）送出。

## 其他注意事項

- 後端以記憶體儲存字幕狀態，若伺服器重啟需重新上傳劇本。
- 為避免洩漏，控制端不會在伺服器保存 OpenAI Key；需於控制端畫面手動輸入。
- 若需要部署到雲端，請確保 3000 連接埠（或自訂）對控制端與檢視端裝置開放，並可依需求設定 HTTPS。
