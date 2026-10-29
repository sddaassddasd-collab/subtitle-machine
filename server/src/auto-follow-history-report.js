const SOURCE_LABELS = Object.freeze({audio: '參考錄音比對', transcript: '文字辨識', onset: '起音預推',
  correction: '跳詞校正', silence: '靜默切換', manual: '人工操作', initial: '起始位置',
  context: '場次／版本切換', resume: '恢復位置', system: '系統定位'});
const STATUS_LABELS = Object.freeze({confirmed: '已確認', pending: '已進入、未確認',
  manual: '人工進入、未確認', initial: '起始／恢復位置，未確認', direction: '舞台指示',
  unentered: '未進入，原因待查', skipped_auto: '自動跨過，未進入', skipped_manual: '人工跨過，未進入'});
const sourceLabel = source => SOURCE_LABELS[source] || source || '';

function historyReport({run, events}) {
  const contexts = new Map(), visits = new Map(), decisions = new Map(), rows = [];
  for (const event of events) {
    if (event.type === 'context') {
      const context = {...event, rows: event.lines.map(line => ({contextId: event.contextId,
        cellId: event.cellId, cellName: event.cellName, language: event.language, ...line,
        visits: [], skips: [], status: line.type === 'direction' ? 'direction' : 'unentered'}))};
      contexts.set(event.contextId, context); rows.push(...context.rows);
    }
    const context = contexts.get(event.contextId), row = context?.rows[event.index];
    if (event.type === 'cue_enter' && row) {
      const visit = {id: event.visitId, enteredAt: event.at, sequence: event.sequence, source: event.source,
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
  let seenAudio = false, hasGaps = false;
  for (const event of events) {
    if (['interruption', 'logging_gap'].includes(event.type) ||
      (event.type === 'capture_audio' && event.gapMs >= 2000) ||
      (seenAudio && event.type === 'capture_status' && ['paused', 'error', 'connecting'].includes(event.status))) hasGaps = true;
    if (event.type === 'capture_audio') seenAudio = true;
  }
  return {schemaVersion: 1, run, rows,
    contexts: [...contexts.values()].map(({rows: _rows, ...context}) => context),
    totals: {cueVersions: rows.filter(row => row.type !== 'direction').length,
      entered: rows.filter(row => row.type !== 'direction' && row.entryCount).length,
      unentered: rows.filter(row => row.type !== 'direction' && !row.entryCount).length,
      visits: rows.reduce((sum, row) => sum + row.entryCount, 0),
      unconfirmedVisits: rows.reduce((sum, row) => sum + row.visits.filter(visit => !visit.confirmations.length && row.type !== 'direction').length, 0)},
    hasGaps, notes: ['未進入不等於辨識失敗；需核對實際演出範圍、人工跳格及收音中斷。',
      '起始位置與場次／版本切換不計為自動觸發；同格重演保留每一次經過。',
      '切格事件逐次保存；確認依來源與辨識片段保留首次及句尾確認，診斷訊息每通道每五秒最多一筆。',
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
function historyCsv(report) {
  const records = [['排練ID', '節目', '開始時間UTC', '劇本版本ID', '場次', '演出語言', '字幕格ID', '字幕格', '台詞',
    '參考片段可用', '參考起點秒', '參考終點秒', '經過次序', '進入方式', '進入時間UTC', '收音串流ID', '現場音訊毫秒',
    '確認來源', '句尾確認', '結果', '跨過來源', '辨識文字', '錄音定位秒', '顯示回報', '紀錄含中斷']];
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
      visit?.displayAcks.map(item => `${item.role}: ${item.ms}ms`).join('、'), report.hasGaps ? '是' : '否']);
  }
  return '\uFEFF' + records.map(record => record.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {historyReport, historyCsv, SOURCE_LABELS, STATUS_LABELS};
