const SOURCE_LABELS = Object.freeze({audio: '參考錄音比對', transcript: '文字辨識', onset: '起音預推',
  correction: '跳詞校正', silence: '靜默切換', manual: '人工操作', initial: '起始位置',
  context: '場次／版本切換', resume: '恢復位置', system: '系統定位'});
const STATUS_LABELS = Object.freeze({confirmed: '已確認', pending: '已進入、未確認',
  manual: '人工進入、未確認', initial: '起始／恢復位置，未確認', direction: '舞台指示',
  unentered: '未進入，原因待查', skipped_auto: '自動跨過，未進入', skipped_manual: '人工跨過，未進入'});
const sourceLabel = source => SOURCE_LABELS[source] || source || '';

function historyReport({run, events, scope}) {
  const contexts = new Map(), visits = new Map(), decisions = new Map(), rows = [];
  const diagnosticTotals = {transcriptRevisions: 0, traceSamples: 0, acousticSummaries: 0, captureSummaries: 0, problemMarks: 0};
  const windows = new Set(), streams = [];
  for (const event of events) {
    if (event.type === 'transcript_revision') diagnosticTotals.transcriptRevisions++;
    if (event.type === 'decision_trace') { windows.add(event.windowId); diagnosticTotals.traceSamples += event.samples.length; }
    if (event.type === 'acoustic_summary') diagnosticTotals.acousticSummaries++;
    if (event.type === 'capture_summary') diagnosticTotals.captureSummaries++;
    if (event.type === 'problem_mark') diagnosticTotals.problemMarks++;
    if (event.type === 'stream_configuration') streams.push(event);
    if (event.type === 'context') {
      const context = {...event, rows: event.lines.map(line => ({contextId: event.contextId,
        cellId: event.cellId, cellName: event.cellName, language: event.language, ...line,
        visits: [], skips: [], heard: [], status: line.type === 'direction' ? 'direction' : 'unentered'}))};
      contexts.set(event.contextId, context); rows.push(...context.rows);
    }
    const context = contexts.get(event.contextId), row = context?.rows[event.index];
    if (event.type === 'cue_enter' && row) {
      const visit = {id: event.visitId, enteredAt: event.at, sequence: event.sequence, source: event.source,
        triggeredAt: event.triggeredAt ?? event.decisionTiming?.decidedAt ?? event.at,
        elapsedMs: event.elapsedMs ?? Math.max(0, (event.decisionTiming?.decidedAt ?? event.at) - run.startedAt),
        timestampSource: event.triggeredAt != null || event.decisionTiming?.decidedAt != null ? 'trigger' : 'legacy_event',
        audioMs: event.audioMs ?? null, streamId: event.streamId || null,
        decisionId: event.decisionId || null, confirmations: [], displayAcks: [],
        decisionTiming: event.decisionTiming || null,
        status: row.type === 'direction' ? 'direction' : event.source === 'manual' ? 'manual'
          : ['initial', 'context', 'resume', 'system'].includes(event.source) ? 'initial' : 'pending'};
      row.visits.push(visit); visits.set(event.visitId, visit);
      if (visit.decisionId) decisions.set(visit.decisionId, visit);
      if (Number.isInteger(event.fromIndex) && event.index > event.fromIndex + 1 &&
        !['initial', 'context', 'resume'].includes(event.source)) {
        for (let index = event.fromIndex + 1; index < event.index; index++) {
          context.rows[index]?.skips.push({at: event.at, source: event.source,
            fromIndex: event.fromIndex, toIndex: event.index, sequence: event.sequence});
        }
      }
    }
    if (event.type === 'cue_confirm') {
      const visit = visits.get(event.visitId);
      if (visit) { visit.confirmations.push(event); visit.status = 'confirmed'; }
    }
    if (event.type === 'cue_heard' && row) row.heard.push(event);
    if (event.type === 'display_ack') {
      const visit = decisions.get(event.decisionId);
      if (visit) visit.displayAcks.push(event);
    }
  }
  for (const row of rows) {
    if (row.visits.length) row.status = row.visits.at(-1).status;
    else if (row.type !== 'direction' && row.skips.length)
      row.status = row.skips.every(skip => skip.source === 'manual') ? 'skipped_manual' : 'skipped_auto';
    row.entryCount = row.visits.length;
    row.autoEntryCount = row.visits.filter(visit => ['audio', 'transcript', 'onset', 'correction', 'silence'].includes(visit.source)).length;
    row.confirmedCount = row.visits.filter(visit => visit.confirmations.length).length;
  }
  let seenAudio = false, hasGaps = false, stoppedNormally = false;
  for (const event of events) {
    if (['interruption', 'logging_gap'].includes(event.type) ||
      (event.type === 'capture_audio' && event.gapMs >= 2000) ||
      (seenAudio && event.type === 'capture_status' && ['paused', 'error', 'connecting'].includes(event.status) &&
        !(event.status === 'paused' && event.reason === 'client requested stop'))) hasGaps = true;
    if (seenAudio && event.type === 'capture_status' && event.status === 'paused' && event.reason === 'client requested stop') stoppedNormally = true;
    if (stoppedNormally && event.type === 'capture_status' && event.status === 'ready') hasGaps = true;
    if (event.type === 'capture_audio') seenAudio = true;
  }
  return {schemaVersion: 2, run, rows, streams,
    diagnostics: scope === 'summary' && run.diagnostics ? run.diagnostics : {...diagnosticTotals, traceWindows: windows.size},
    contexts: [...contexts.values()].map(({rows: _rows, ...context}) => context),
    totals: {cueVersions: rows.filter(row => row.type !== 'direction').length,
      entered: rows.filter(row => row.type !== 'direction' && row.entryCount).length,
      unentered: rows.filter(row => row.type !== 'direction' && !row.entryCount).length,
      visits: rows.reduce((sum, row) => sum + row.entryCount, 0),
      unconfirmedVisits: rows.reduce((sum, row) => sum + row.visits.filter(visit => !visit.confirmations.length && row.type !== 'direction').length, 0)},
    hasGaps, notes: ['未進入不等於辨識失敗；需核對實際演出範圍、人工跳格及收音中斷。',
      '起始位置與場次／版本切換不計為自動觸發；同格重演保留每一次經過。',
      '切格事件逐次保存；確認依來源與辨識片段保留首次及句尾確認，診斷訊息每通道每五秒最多一筆。',
      '文字涵蓋代表該段辨識能對應此格，不代表該格曾顯示；跨格不會回放已過時的字幕。待確認錄音也可參與聲音比對，狀態仍保留待確認。',
      '觸發時間為伺服器決策時間（毫秒）；recordedAt 為記錄處理時間。舊事件缺少觸發時間時沿用當時的事件時間。',
      '辨識修訂逐次保存；決策暫存保留觸發前 5 秒及後 3 秒，重疊樣本不重複保存，單窗最長 10 秒、暫存最多 160 個分析結果。',
      '聲音及收音摘要每五秒彙整，匯出與暫停時保存尚未滿五秒的摘要；不包含現場原始音訊。超長文字與詞陣列有上限並標示截短。',
      '音訊時間以收音串流為單位，串流重啟會歸零；請連同串流 ID、事件序號及伺服器時間核對。',
      '顯示回報表示瀏覽器回報已處理畫面，不代表觀眾實際看見；沒有回報也不能直接判定漏顯示。'],
    events};
}

function csvCell(value) {
  let text = String(value ?? '');
  // Protect spreadsheet users from formulas in script/transcript/user names.
  if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const iso = at => Number.isFinite(at) ? new Date(at).toISOString() : '';
const taipeiFormatter = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false});
const taipei = at => Number.isFinite(at) ? taipeiFormatter.format(at) : '';
function historyCsv(report) {
  const records = [['排練ID', '節目', '開始時間UTC', '劇本版本ID', '場次', '演出語言', '字幕格ID', '字幕格', '台詞',
    '參考片段可用', '參考起點秒', '參考終點秒', '經過次序', '進入方式', '進入時間UTC', '收音串流ID', '現場音訊毫秒',
    '確認來源', '句尾確認', '結果', '跨過來源', '辨識文字', '錄音定位秒', '顯示回報', '紀錄含中斷', '文字涵蓋', '涵蓋辨識文字',
    '觸發時間UTC', '觸發時間台北UTC+08', '距紀錄開始秒', '觸發時間來源', '觸發證據音訊毫秒']];
  for (const row of report.rows) for (const [index, visit] of (row.visits.length ? row.visits : [null]).entries()) {
    const confirmations = visit?.confirmations || [];
    records.push([report.run.id, report.run.name, iso(report.run.startedAt), row.contextId, row.cellName || row.cellId,
      row.language, row.id, row.index + 1, row.text, row.reference.usable ? '是' : '否', row.reference.start, row.reference.end,
      visit ? index + 1 : '', sourceLabel(visit?.source), iso(visit?.enteredAt), visit?.streamId, visit?.audioMs,
      [...new Set(confirmations.map(item => sourceLabel(item.source)))].join('、'),
      confirmations.some(item => item.completed) ? '是' : '否', STATUS_LABELS[visit?.status || row.status],
      [...new Set(row.skips.map(item => sourceLabel(item.source)))].join('、'),
      confirmations.map(item => item.text).filter(Boolean).join(' / '),
      confirmations.filter(item => Number.isFinite(item.referenceSeconds)).at(-1)?.referenceSeconds,
      visit?.displayAcks.map(item => `${item.role}: ${item.ms}ms`).join('、'), report.hasGaps ? '是' : '否',
      row.heard?.length ? '是（不代表已顯示）' : '', [...new Set((row.heard || []).map(item => item.heard))].join(' / '),
      iso(visit?.triggeredAt), taipei(visit?.triggeredAt), visit ? (visit.elapsedMs / 1000).toFixed(3) : '',
      visit ? visit.timestampSource === 'trigger' ? '觸發決策' : '舊版事件時間' : '',
      visit?.decisionTiming?.transcriptAudioEndMs ?? visit?.decisionTiming?.audioEndMs ?? visit?.decisionTiming?.onsetAudioMs ?? visit?.decisionTiming?.silenceAudioMs]);
  }
  return '\uFEFF' + records.map(record => record.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {historyReport, historyCsv, SOURCE_LABELS, STATUS_LABELS};
