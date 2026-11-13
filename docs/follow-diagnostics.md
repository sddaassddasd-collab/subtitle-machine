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

傳輸版本 7／pipeline 版本 4：未確認音訊窗口由 4 秒起步，依實測 ACK 往返延遲增加（1.5 倍 RTT 加 1 秒餘裕），最多 12 秒，單次連線內不縮小；以 `uploadWindowMs` 記錄有效值。音訊與送出緩衝仍有硬上限。積壓本身只產生 `capture_backlog_waiting` 與延遲狀態，不再觸發重連；20 秒沒有累計接收進度才記錄 `capture_reception_stalled` 並恢復連線。探測成功但序號不前進不算恢復。真正斷線仍使用既有有限重試；成功重連保留既有有界佇列，不再額外裁成 1 秒。容量超限與實際過期仍可能裁音，持續低於即時需求的頻寬無法保證不丟音。

診斷版本 21 新增 `packetSequence`，與歷史事件的全域 `sequence` 分開。封包時間鏈應以 `captureId + packetSequence` 串接；舊版 sequence 已被匯出事件序號覆寫，不能可靠地當作封包編號。

伺服器診斷版本 22：Deepgram 的 audio-thread-v2 串流遇到供應商送出緩衝達 48,000 bytes（約 1 秒 PCM）時，改在伺服器排隊，最多保留 12 秒。等待期間不確認為已提交；探測只回報已送交的封包序號。恢復後以不超過 1.25 倍即時速度追趕，避免一次灌入整批積壓。佇列 20 秒沒有提交進度或超出容量時才停止該串流並回報恢復需求。實際送出錯誤、斷線仍沿用既有處理；這些上限不能保證頻寬長期不足時不丟音。

`provider_queue_waiting`、`provider_queue_drained`、`provider_queue_stalled`、`provider_queue_full` 位於 transport_health。`providerQueuedAudioMs`／`providerQueueAgeMs` 記錄伺服器待提交量／最老等待時間，與 WebSocket 的 `providerBufferedBytes` 分開。關閉有待提交音訊的串流時，`provider_queue_abandoned` 保存來源範圍與首尾封包序號。供應商是否真正接收、處理，仍需搭配辨識結果進度判斷。有效參數保存於 stream_configuration.effectiveSettings.providerQueue。

診斷版本 23：客戶端 `capture_socket_disconnect` 保存 Socket.IO 的 `disconnectReason`、可取得時的 WebSocket `socketCloseCode`、最近封包與心跳的經過時間（`lastSocketPacketAgeMs`／`lastHeartbeatAgeMs`），並以 stage 區分 intentional／unexpected。不保存原始封包或任意錯誤物件；未知關閉碼／尚未觀察到心跳時不填值。伺服器另以 `server_socket_disconnect` 記錄音訊連線的斷線原因及供應商佇列狀態，以兩端證據判斷來源。這些欄位用於診斷，不代表已修好斷線來源。

文字規則版本 14（回復後的新變更）：`nearby_insertions` 允許近期已定位位置的前方 6 格內，完整台詞僅多出最多 2 個指定功能／語助字時恢復位置。必須保留劇本所有字與順序，不允許藉此更改否定詞、替換文字、跨音樂或舞台指示邊界；未完成句與歧義候選不適用。有效參數保存於 textSettings 的 insertionRecovery 欄位。兩份不同排練的實際候選均有回歸案例；語意核對仍用於超出此容錯範圍的改寫。

Pipeline 版本 5 的回到即時模式：本機最老待送音訊年齡，或最近 5 秒 ACK 帶回的相對來源延遲加供應商等待時間，達 3 秒且持續 2 秒時，記錄 `capture_return_to_live`，切換音訊串流並將本機佇列裁至最近約 240 ms。這個判斷不以 ACK 往返時間當成單程延遲；伺服器相對延遲仍有初始時鐘基準限制，不能視為精確絕對延遲。

回到即時採用既有 capture generation／stream identity 隔離：關閉舊傳輸、建立新 captureId，舊 ACK 及舊供應商串流結果不得修改新串流；既有字幕位置保留，等待新語音重新定位。連線建立期間仍持續本機收音，成功建立後再裁至即時邊緣。`capture_drop_range.cause=return_to_live` 記錄確定捨棄的本機音訊；已送出但未確認的區間仍用 capture_unacknowledged_range 記錄，不重複當成確定丟音。

兩次回到即時至少相隔 30 秒；同一未恢復穩定的期間最多執行兩次。受限時記錄 `capture_live_reset_suppressed` 並顯示傳輸不穩；連續 30 秒觀察到低於 1 秒的延遲後重設次數。真正斷線的既有重試仍保留。此模式有意犧牲舊台詞以恢復現場同步，不保證網路持續不足時仍能即時。

文字規則版本 15：目前格已完成後，與句尾相隔不超過 250 ms、且只有「嘛啊呀呢喔哦啦吧唷」的延伸先不花掉下一格預推。若下一格本身就是該短句，或語音在停頓後開始，仍可立即切入。帶時間詞表時只移除完整的句尾語助詞詞區間，不估造詞內邊界；後續實質文字仍可觸發下一格。兩份同音檔排練紀錄的「不快樂嘛」都有重播案例。

`independent_cue_recovery` 是受限的兩句恢復路徑：附近 6 格內、至少 6 字面配對、分數至少 .65 且保留否定詞的弱文字／發音候選先存為 supportedRecovery，不直接切格。8 秒內另一個辨識項目的新音訊若完整吻合其相鄰下一句（至少 3 字），才恢復到該位置；不補播之前台詞，也不宣告句尾完成。缺少詞時間、重疊音訊、同項目重送或改寫、歧義及音樂／指示邊界不構成佐證；同項目的矛盾改寫會取消原假設。stream/script 重設會清除假設。有效參數存於 textSettings，候選暫存可見於 trackerSnapshot.supportedRecovery。

### 即時字幕返回劇本的附近佐證

Performance 設定版本 8：背景定位可保留六格內、已到句尾、至少六字吻合的弱候選（最低信心 0.65、候選差距至少 0.07）。候選必須有對齊的辨識字詞時間，不得跨舞台指示或音樂，否定詞亦須一致。弱候選本身不觸發返回。

八秒內另一個辨識項目若以不重疊的音訊完整吻合緊接台詞（至少三字），才可作為返回佐證。仍遵守人工鎖定與模式切換等待時間；同項目改稿、撤回文字與過期證據不算獨立佐證。返回決策的 `nearbySupported` 與 `supportingIndex` 可用於辨識此路徑。轉入即時字幕時清除一般跟隨器的待確認候選；一般待確認候選亦會隨音訊時間及原始位置失效而清除。

### 附近改述的片語定位

文字設定版本 16、診斷版本 25、Performance 設定版本 9：一般劇本跟隨新增 `nearby_phrase_recovery`。僅在原有定位與字詞路徑無法採用時，使用有對齊字詞時間的定稿，從目前格起最多向前三格比對依序出現的文字片語。至少兩段片語、每段至少兩字、合計至少八字，須涵蓋至少一半目標台詞及 35% 辨識文字，並領先附近其他候選至少 0.15。最近可靠文字錨點、否定詞、同項目前進限制及音樂／舞台指示邊界仍須通過。

此路徑只恢復位置，`completed` 維持 false，不回放中間格、不準備下一次盲推，亦不更新可靠逐字錨點。紀錄的 `phraseAnchored`、`phraseIslands` 與候選信心（片語涵蓋率，非模型機率）可辨識此路徑。它可補救插字及局部改述，不能處理完全沒有足夠共同文字的改述或嚴重錯字；不以逾時本身作為推進依據。

回歸資料 `phrase-rehearsal.json` 保留 1c8293ff 紀錄中的實際辨識文字及原始字詞時間，涵蓋第 218 格搔癢療法改述，以及第 339 格未確認後定位第 341 格的國王／歌手／來我家片語。

### 大幅向後定位與附近順序恢復

文字設定版本 17、診斷版本 26：超過向後三格的文字候選，包含定稿與高分句尾，不再直接觸發回跳。`backward_support_required` 表示保留候選；十秒內必須有不同辨識項目、音訊不重疊的下一句強文字證據，才以 `independent_backward_recovery` 恢復較早位置。改稿、歧義、無字詞時間、位置變更或過期均不能完成此佐證。等待時不消耗下一格預推；人工移動不受限制。`backwardRecovery` 保存候選與原始音訊範圍，`backwardSupported`、`supportingIndex` 說明返回證據。

`independent_cue_recovery` 現可保留目前未確認格或緊接格的弱候選，並接受後續獨立語音的可靠部分文字，不必等完整下一句。部分證據至少四字吻合、信心至少 0.86，且須通過附近候選差距與否定詞檢查；三字以上的完整下一句仍可使用。長辨識項目可從實際字詞邊界取得近期證據，事件及證據時間沿用供應商時鐘。此路徑不宣告句尾完成、不回放漏格、不準備連續盲推；目前句已確認結束後的新語音預推機制維持原規則。沒有新證據時，逾時只讓候選失效，不自行前進。

回歸資料 `backward-rehearsal.json` 摘錄 ef45bfcf 的第 506 → 477 格誤退案例。這次未改動唱歌區段、歌詞顯示或歌後搜尋策略。

### 獨立位置追蹤與走 cue 的背景比較

診斷版本 27、shadow 版本 1（`observe_only`）：每份已通過語言、供應商串流及丟音範圍檢查的辨識修訂，會同時提供給既有走 cue 流程與獨立位置追蹤器。追蹤器使用自己的 `locateTranscript` 狀態與位置，不呼叫快速預推包裝、不採用畫面的每次預推作為搜尋原點、不呼叫第二次 STT 或語意模型。這一版只比較文字定位，既有付費語意補救仍屬原走 cue 流程。

追蹤在原走 cue 處理結束後排程，每輪處理一筆，有 64 筆佇列上限。溢出會捨棄最舊的診斷工作、記錄 `droppedRevisions` 並清除舊追蹤證據；這不代表丟棄音訊。每筆另記 `queueWaitMs`、`processingMs`。它在同一伺服器程序中執行，仍有額外運算成本，並未宣稱與即時工作完全隔離 CPU。

匯出 JSON 新增 `tracking_comparison` 事件及 `diagnostics.trackingComparisons` 計數。請用 `revisionId` 與原始 `transcript_revision` 對應，並核對 `streamId`、`providerStreamId`、`audioStartMs`／`audioEndMs`、`scriptSignature` 及 `generation`；比較的是該份修訂處理完時的畫面狀態，不是背景工作稍後執行時的畫面。保存時沿用原始修訂的場次脈絡；若原始修訂未保存或已換成另一輪紀錄，較晚完成的比較不會寫入新一輪。這也不是額外的瀏覽器顯示 ACK，稍後完成的非同步語意決策仍須另讀其決策與換格事件。

- `aligned`：此次追蹤接受的位置與劇本畫面位置一致。
- `awaiting_confirmation`：畫面預推一格，追蹤仍停在先前確認位置，屬正常待確認狀態。
- `tracking_uncertain`／`ignored_evidence`：此次文字未建立可採用位置／被時序等規則忽略，不能據此判定畫面錯誤。
- `locator_ahead`／`display_ahead`：兩者有位置差距；`requiresReview` 只在定稿、可靠定位及超過一格差距時標記待檢查，不會修正畫面。
- `live_output`／`caption_handoff`／`display_hidden`：輸出即時字幕、保留既有文字或隱藏字幕，不按一般劇本位置差距計為誤跳。
- `shadow_error`：背景追蹤失敗，後續可重新建立追蹤，走 cue 不受此錯誤控制。

`locator.index` 與 `confirmedIndex` 分別是最近採用的位置及較強文字證據的位置；`completed` 只描述追蹤目前位置的已確認句尾。這些都是演算法判斷，不是人工標註的真實位置。兩流程共用辨識來源，所以 `independentEvidence` 固定為 false；結果一致不能當作兩份獨立音訊佐證。

人工定位、場次／語言切換與追蹤重設會取消舊佇列。相同劇本的收音重連保留獨立定位起點，但清除舊音訊證據；新增丟音界線亦會隔離舊範圍。初始及劇本變更時才以當時選定位置初始化，之後一般畫面換格不重新設定追蹤位置。本版本未新增自動仲裁或改變既有預推規則。
