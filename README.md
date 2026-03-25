# 劇場字幕機

這個專案提供一個含「控制端」與「檢視端」的劇場字幕機。控制端可以直接貼上劇本文字並呼叫 OpenAI 拆解成字幕句子、即時編輯與播放；檢視端僅顯示目前字幕，適合給觀眾或表演者在手機/平板上即時查看。

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
   然後造訪 http://localhost:3000/ ，輸入共用密碼後進入系統。

## 使用流程（控制端）

1. 先進入首頁並輸入共用密碼，登入系統後可查看既有場次或建立新場次。
2. 於畫面左側輸入 OpenAI API Key（可以勾選「在此裝置記住」以存入瀏覽器 localStorage）。
3. 直接貼上劇本文字並點選「使用 OpenAI 拆解字幕」，系統會呼叫 `gpt-4o-mini` 將台詞拆成適合字幕的句子，舞台指示與角色頭銜會被濾除；字幕長度限制採全形字寬估算，英文等非中文語系不會再被直接當成 20 個字元硬切。
4. 拆解完成後，右側會顯示完整字幕清單，可直接編輯（contentEditable）。單擊某一句或使用鍵盤方向鍵 `↑` / `↓` 會切換外部字幕；雙擊文字本身可直接進入編輯，不會再把畫面捲走。
5. 角色資訊會保留在字幕資料裡，是否以顏色區分角色改由控制端切換，檢視端與投影端會同步套用。
6. 需要暫時關閉觀眾字幕時，點「遮蔽檢視端字幕」即可讓檢視端畫面變成空白，但控制端仍可瀏覽全文、以 `Command + F` 搜尋並點擊跳轉。
7. 若要手動備份場次，可在控制端使用「匯出場次備份 JSON」；備份會保留原本 `sessionId`、viewer/projector token、語言、所有儲存格與字幕內容。
8. 若要還原備份，可回到首頁，使用「匯入場次備份 JSON」；若備份中的 `sessionId` 已存在，系統會拒絕匯入，避免悄悄改號。

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
6. 後端預設改用 `semantic_vad` 做語意切段，讓 Realtime API 依句意決定何時結束片段；控制端不再提供此選項，預設固定開啟。
7. 語意切段模式下仍保留超時保底 `commit`，若約 2.2 秒都未切出新片段，後端會手動補一次 `commit`，避免長時間完全沒有字幕輸出。
8. 顯示層不再把每個 OpenAI item 硬當成一行；後端會把 completed fragments 重新分組，切段時同時參考 `semantic_vad`、最近靜音長度、標點傾向、最短/最長字數，以及中文不適合切開的位置。
9. 英文與其他拉丁語系片段現在也會額外參考半形字寬、句尾標點與常見英文接續詞，避免句子尚未完成就過早切行。
10. 若偵測到弱邊界（例如 fallback commit 切得太早），後端會把相鄰片段合併後再做一次較高精度的重轉錄/後修正，再回填到同一行。
11. 手動 commit 單一路徑仍可在關閉語意切段時使用（預設約 900ms 一段，且每段至少 400ms 音訊）。
12. 雙通道精修預設固定開啟；快通道完成後，後端會以同段原始音訊做一次 `audio.transcriptions.create` 回填精修。
13. 控制端可額外勾選「辨認講者」；開啟後，後端會把最近幾行音訊視窗送到 `gpt-4o-transcribe-diarize` 做說話人分離，並在檢視端以不同顏色標示不同講者。
14. 控制端可輸入「辨識主題 / 術語提示」；後端會把這份提示同時套用到 Realtime 快通道、雙通道精修與後修正，讓專有名詞與領域詞彙更穩定。
15. 若「辨識主題 / 術語提示」留白，系統不會送出額外主題 prompt，行為等同目前預設辨識流程。
16. 控制端收音會保留雙聲道輸入並混成 mono，避免 `BlackHole 2ch` 或其他立體聲來源只吃到單邊聲道。
17. 當語言是 `zh`（或 `zh-*`）時，後端會做 OpenCC（簡轉繁，台灣用字）正規化，預設不送額外轉錄提示詞，避免提示詞內容誤出現在字幕。
18. 劇本字幕清單每行可勾選「此處有音樂」；先勾起點再勾終點，控制端會自動把中間整段標成音樂區段，檢視端在該範圍內會固定顯示「此處有音樂」提示。

可用環境變數微調即時性與穩定性（後端）：

- `TRANSCRIPTION_SEMANTIC_SEGMENTATION_ENABLED`：控制端未指定時，是否預設開啟語意切段（預設 `true`）。
- `TRANSCRIPTION_SEMANTIC_VAD_EAGERNESS`：語意切段速度，可選 `low` / `medium` / `high` / `auto`（預設 `high`）。
- `TRANSCRIPTION_SEMANTIC_FALLBACK_COMMIT_MS`：語意切段模式下，最長等待多久仍沒切段就強制補一次 `commit`（預設 `2200`）。
- `TRANSCRIPTION_SILENCE_LEVEL_THRESHOLD`：判定最近輸入是否接近靜音的音量門檻（預設 `0.012`）。
- `TRANSCRIPTION_BOUNDARY_MIN_CHARS`：偏短片段不容易直接斷行（預設 `10`）。
- `TRANSCRIPTION_BOUNDARY_SOFT_MAX_CHARS`：到達這個長度後更傾向斷行（預設 `26`）。
- `TRANSCRIPTION_BOUNDARY_HARD_MAX_CHARS`：超過這個長度時強制開始新行（預設 `38`）。
- `TRANSCRIPTION_BOUNDARY_WEAK_PAUSE_MS`：短停頓加分門檻（預設 `120`）。
- `TRANSCRIPTION_BOUNDARY_STRONG_PAUSE_MS`：強停頓加分門檻（預設 `320`）。
- `TRANSCRIPTION_FORCE_COMMIT_INTERVAL_MS`：commit 週期（預設 `900`）。
- `TRANSCRIPTION_MIN_COMMIT_AUDIO_MS`：最小音訊長度才 commit（預設 `400`）。
- `TRANSCRIPTION_COMMIT_COOLDOWN_MS`：兩次 commit 的最小間隔（預設 `500`）。
- `TRANSCRIPTION_DUAL_CHANNEL_ENABLED`：控制端未指定時的雙通道精修預設值（預設 `true`）。
- `TRANSCRIPTION_SPEAKER_RECOGNITION_ENABLED`：控制端未指定時，是否預設開啟講者辨認（預設 `false`）。
- `TRANSCRIPTION_SPEAKER_WINDOW_MAX_LINES`：每次講者辨認時最多合併幾行近期字幕（預設 `4`）。
- `TRANSCRIPTION_SPEAKER_WINDOW_MAX_MS`：每次講者辨認視窗的最大音訊長度（預設 `16000`）。
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

- 後端目前採用雙儲存策略：
  - 若有設定 `DATABASE_URL`，優先使用 PostgreSQL
  - 若未設定 `DATABASE_URL`，才 fallback 到本機 SQLite
- 首頁目前採用單一共用密碼入口；若未設定環境變數，預設密碼為 `20141017`。可用 `SUBTITLE_MACHINE_ACCESS_PASSWORD` 覆寫。
- Render 部署建議直接綁定 Render Postgres，平台會自動提供 `DATABASE_URL`，此時帳號、登入 session 與字幕場次資料都會寫進 Postgres，不會因 redeploy 消失。
- 若你使用 Render 免費 Web Service，又不打算加購 Persistent Disk / Postgres，請把「場次備份 JSON 匯出 / 匯入」當成正式備份流程；免費環境的本機檔案系統不適合長期保存字幕資料。
- SQLite fallback 模式的預設資料庫位置不在 repo 內，而是在系統使用者資料夾：
  - macOS：`~/Library/Application Support/subtitle-machine/app-store.sqlite`
  - Linux：`~/.local/share/subtitle-machine/app-store.sqlite`
  - Windows：`%APPDATA%/subtitle-machine/app-store.sqlite`
- SQLite fallback 依賴 `node:sqlite`；若你不使用 `DATABASE_URL`，請確認 Node.js runtime 支援該模組。
- 若未使用 `DATABASE_URL`，可用 `SUBTITLE_MACHINE_DATA_DIR` 指定自訂 SQLite 資料夾；伺服器啟動時若偵測到舊的 `server/data/app-store.json`，會自動搬遷到新的儲存層。若已切到 Postgres，系統也會嘗試把既有本機 SQLite / 舊 JSON 內容匯入 Postgres。
- 控制端的 QR code 現在改為本地產生，不會再把 viewer 亂碼網址送到第三方 QR 服務。
- 忘記密碼流程已改成「送出申請，請管理員於後台協助重設」，前台不再直接取得重設碼。
- 若要部署到正式環境，至少應設定：
  - `ALLOWED_ORIGINS=https://你的網域`
  - `COOKIE_SECURE=true`
  - `COOKIE_SAME_SITE=lax`（若前後端真的跨站，才考慮 `none`，且必須同時開 `COOKIE_SECURE=true`）
  - `TRUST_PROXY=1`（若前面有 Nginx / reverse proxy / platform proxy）
- 若部署在 Render，建議 Web Service 直接綁定 Render Postgres，並至少設定：
  - `DATABASE_URL`：Render 會自動注入
  - `POSTGRES_SSL=true`：若連的是需要 SSL 的 Postgres 連線
  - `ALLOWED_ORIGINS=https://你的正式網域`
  - `COOKIE_SECURE=true`
  - `TRUST_PROXY=1`
  - 使用 Postgres 時不需要再掛 Persistent Disk 來保存帳號或場次資料
- 為避免洩漏，控制端不會在伺服器保存 OpenAI Key；需於控制端畫面手動輸入。
- 若需要部署到雲端，請確保 3000 連接埠（或自訂）對控制端與檢視端裝置開放，並可依需求設定 HTTPS。
