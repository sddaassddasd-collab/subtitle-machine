# 跟隨紀錄診斷欄位

匯出的 follow JSON 保留以下事件，不包含原始 PCM。診斷不改變字幕定位或傳輸恢復規則。

- `capture_health.reason=capture_packet_timing`：每秒最多抽樣一個累計 ACK 對應封包。以 `captureId + sequence` 串接伺服器事件；附 `streamId`、`providerStreamId`、來源音訊範圍、`generatedAt`（該批音訊產生時間）、`queuedAt`、`sentAt`、`serverReceivedAt`、`providerSubmittedAt`、`acknowledgedAt`、`clientAckReceivedAt`。時間鏈抽樣不是每個封包的完整追蹤；遺失的 ACK 不會產生客戶端完成鏈。
- `clockOffsetMs` 是伺服器時間減客戶端時間的估計：`((serverReceivedAt - sentAt) + (acknowledgedAt - clientAckReceivedAt)) / 2`。`clockUncertaintyMs` 是扣除伺服器停留後的半個往返時間。假設上下行對稱，不能視為精確單程延遲。使用時先校正時鐘，不能直接相減兩端時間。
- `capture_health.reason=capture_progress` 每秒記錄來源累計 `generatedAudioMs`、`droppedAudioMs`、佇列量，以及當前連線的 `sentAudioMs`。來源累計跨重連保留；連線累計隨 `captureId` 重設。
- `audio_progress`：伺服器每秒在收到封包時記錄 `receivedAudioMs`、`providerSubmittedAudioMs`、`recognizedAudioMs`，皆依串流分開計算。最後一項是辨識服務結果已涵蓋的最大音訊結束位置，**不是供應商內部已處理量**；尚未回傳結果時無法得知內部進度。沒有封包抵達時不會虛構接收進度。`providerSubmittedAt` 表示呼叫送入供應商連線完成，不代表供應商已接收或辨識。
- `capture_health.reason=capture_drop_range`：客戶端每次裁切／過期的來源音訊範圍與原因，含 `queue_overflow`、`source_expired`、`queue_expired`、`reconnect_trim`。伺服器的 `capture_drop_range` 記錄收到但未提交的封包，例如 `expired_input`、供應商尚未就緒。以來源範圍去重，不應將不同階段重複計算。
- `capture_recovery_before`、`connection_retry_scheduled`、`capture_recovery_ready`、`capture_recovery_after`（均位於 capture_health 的 reason）：重連前的積壓與累計、原因與等待時間、重連保留與丟棄量，以及成功連線後 5／10 秒快照。新的重連會開始新的快照時間窗；未存活到該時間則沒有該筆 after。
- `transcript_revision.searchDiagnostics`：當時文字／語意有效門檻、一般文字搜尋範圍及拒絕原因；搭配既有 before/after、candidate、correctionCandidates 和 decision_trace 判讀。全劇本修正候選不等於一般局部搜尋範圍。
- `semantic_candidate` 既有 requested 事件保留實際送給模型的候選；既有拒絕事件保留 reason、rawMatches、分數與詞區間。
- `stream_configuration.server`：伺服器 commit（部署環境或本機 Git 可取得時）、Node／套件版本、啟動時間與診斷版本。`effectiveSettings` 保存伺服器有效規則；前端版本仍在 frontend.build，前端 pipeline 的有效設定另存 `capture_pipeline_settings`。

`*At` 使用各自機器的 epoch milliseconds；`sourceStartMs/sourceEndMs` 是來源音訊時鐘，不能當成 epoch 時間。客戶端診斷會經既有有界 outbox 上傳；斷線或超出容量時可能不完整，因此沒有事件不代表沒有發生。

`capture_unacknowledged_range` 記錄關閉連線時尚未確認的來源範圍。這些封包可能已到達伺服器，不能直接算成確定丟音；需與伺服器端事件核對。

文字定位規則版本 13：已確認目前格完成（或從舞台指示起步）時，句尾之後的新語音文字會暫定切入下一格，不要求符合下一格開頭。仍使用 `prepared_short_opening` 記錄這次暫定切入，`completed=false`、`locationOnly=true`，不代表內容已確認。未完成的目前格仍保留原本依下一格開頭匹配的預推路徑。單次暫定切入不會自動準備再下一格，必須先核對新位置；舊音訊、重送與前文改寫不得當成新增語音。
