# 字幕機壓力測試

## 80 人觀眾連線測試

已安裝 `client` 的依賴套件時，可執行：

```bash
node load-test/watch-viewers.cjs
```

約 20 秒逐步建立 80 位觀眾，全部連線並收到初始字幕後，再共同保持 5 分鐘。使用與觀眾頁相同的 Socket.IO 預設傳輸設定，每 5 秒檢查 `/healthz`，記錄斷線、初始載入時間及各字幕版本的接收人數。結果存於 `load-test/reports/80-watch-時間.json`。

可用 `TARGET`、`VIEWER_TOKEN`、`ARRIVAL_COUNT`、`RAMP_SECONDS`、`HOLD_SECONDS` 覆寫設定。程式只讀取觀眾資料，不操作播放位置；若期間沒有切換字幕，結果只驗證連線維持與初始字幕接收。健康檢查時間不代表字幕顯示延遲，CPU 與記憶體需另外查看 Render Metrics。

這組測試針對正式站的公開觀眾端，模擬 Socket.IO 觀眾載入目前字幕、加入場次房間及保持長連線。預設使用：

- 正式站：`https://subtitle-machine.onrender.com`
- 觀眾場次：`Xh_eF4Gg_0h_MJvsXPdFOrFW`
- 控制端：`https://subtitle-machine.onrender.com/control/session_K0s-dc6u-BSS8oGc`

測試不會登入控制端，也不會修改字幕內容。播放位置必須由已登入的真實控制端操作。

## 執行順序

請避開正式演出時段。先開啟 Render 的 Metrics 與 Logs，再依序執行：

```bash
cd "/Users/lichengjun/Desktop/程式設計/字幕機"
./load-test/run.sh smoke
./load-test/run.sh 100
./load-test/run.sh 200
./load-test/run.sh 300
```

各項設定：

| 指令 | 觀眾數 | 建立連線時間 | 保持時間 |
| --- | ---: | ---: | ---: |
| `smoke` | 10 | 10 秒 | 2 分鐘 |
| `100` | 100 | 30 秒 | 10 分鐘 |
| `200` | 200 | 45 秒 | 10 分鐘 |
| `300` | 300 | 60 秒 | 30 分鐘 |

不要在前一項仍在執行時啟動下一項，否則連線數會相加。

測試執行時，可以另開一個終端機持續記錄健康檢查：

```bash
cd "/Users/lichengjun/Desktop/程式設計/字幕機"
./load-test/monitor-health.sh
```

按 `Control + C` 停止，結果會保存在 `load-test/reports/health-時間.log`。

## 每秒跳一次字幕

1. 用 Chrome 開啟上方控制端連結並登入。
2. 按 `Command + Option + J` 開啟 DevTools Console。
3. 貼上 `control-console.js` 的全部內容。
4. 停止時輸入：

```js
clearInterval(window.subtitlePressureTimer)
```

這段程式會真的改變該節目的播放位置。

## 模擬手機背景切換

等 `300` 測試達到 300 位觀眾後，在第二個終端機執行：

```bash
cd "/Users/lichengjun/Desktop/程式設計/字幕機"
./load-test/run.sh reconnect
```

這會持續 30 分鐘、每秒建立一個短連線，模擬手機回到前景時重新讀取字幕及加入 Socket.IO 房間。它是偏嚴格的重連壓力，不等同完整的 iOS/Safari 背景機制，因此仍應搭配 3 至 5 支真手機反覆切換 App。

## 改用其他場次

不必修改檔案，可以在指令前覆寫環境變數：

```bash
TARGET="https://example.com" \
VIEWER_TOKEN="另一個觀眾Token" \
./load-test/run.sh smoke
```

## 驗收重點

- Artillery 沒有 `vusers.failed` 或 Socket.IO 連線錯誤。
- 真實觀眾端通常在一秒內更新，沒有停住三秒以上。
- 真手機回到前景後能在二至三秒內同步目前字幕。
- Render 沒有 health check timeout、502/503、instance restart。
- CPU 沒有長時間貼住上限，記憶體沒有持續只升不降。

JSON 結果會保存在 `load-test/reports/`；此資料夾已被 Git 忽略。

Artillery 在這組測試中負責產生及維持觀眾連線；字幕真正顯示到畫面的延遲，請以另外開啟的真實觀眾頁面判斷。這可避免把 Artillery 自身的事件等待機制誤當成字幕延遲。
