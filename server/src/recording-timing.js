// ASR times always remain in the original decoded sample clock. Calibration
// maps that clock to the local player's clock; it never edits the source words.
const round = value => Math.round(value * 1000000) / 1000000;
function calibration(value) {
  const scale = value?.scale ?? 1, offset = value?.offset ?? 0;
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 2 || !Number.isFinite(offset))
    throw new Error('錄音時間校正格式錯誤');
  return {scale, offset};
}
const toPlayback = (seconds, value) => { const c = calibration(value); return round(seconds * c.scale + c.offset); };
const toAnalysis = (seconds, value) => { const c = calibration(value); return round((seconds - c.offset) / c.scale); };
const playbackDuration = recording => recording.playbackDuration || recording.duration;

function timedWords(words, duration, correction) {
  const c = calibration(correction);
  return (words || []).flatMap((word, id) => {
    if (typeof word?.word !== 'string' || !Number.isFinite(word.start) || !Number.isFinite(word.end) ||
      word.start < 0 || word.end <= word.start || word.end > duration + 0.1) return [];
    return [{id, word: word.word, rawStart: word.start, rawEnd: word.end,
      start: round(word.start * c.scale + c.offset), end: round(word.end * c.scale + c.offset),
      confidence: Number.isFinite(word.confidence) ? word.confidence : 0.8}];
  }).sort((a, b) => a.start - b.start || a.id - b.id);
}

function fitCalibration(anchors, words, duration, playerDuration = duration) {
  if (!Array.isArray(anchors) || anchors.length > 12 || !Number.isFinite(playerDuration) || playerDuration <= 0 || playerDuration > 86400)
    throw new Error('請提供有效的播放長度及最多 12 個時間定位點');
  if (!anchors.length) return {scale: 1, offset: 0, anchors: []};
  const used = new Set();
  const points = anchors.map(anchor => {
    const word = words?.[anchor.wordId], edge = anchor.edge || 'start';
    if (!Number.isSafeInteger(anchor.wordId) || !word || !['start', 'end'].includes(edge) ||
      !Number.isFinite(word[edge]) || word[edge] < 0 || word[edge] > duration + 0.1 ||
      !Number.isFinite(anchor.time) || anchor.time < 0 || anchor.time > playerDuration ||
      used.has(`${anchor.wordId}:${edge}`)) throw new Error('時間定位點已失效或超出錄音，請重新選擇辨識詞');
    used.add(`${anchor.wordId}:${edge}`);
    return {wordId: anchor.wordId, edge, time: anchor.time, raw: word[edge]};
  }).sort((a, b) => a.raw - b.raw);
  let scale = 1, offset;
  if (points.length > 1) {
    if (points.at(-1).raw - points[0].raw < 5) throw new Error('校正時間比例時，請選至少相隔 5 秒的兩個位置');
    const x = points.reduce((sum, p) => sum + p.raw, 0) / points.length;
    const y = points.reduce((sum, p) => sum + p.time, 0) / points.length;
    scale = points.reduce((sum, p) => sum + (p.raw - x) * (p.time - y), 0) /
      points.reduce((sum, p) => sum + (p.raw - x) ** 2, 0);
    offset = y - scale * x;
  } else offset = points[0].time - points[0].raw;
  if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) throw new Error('需要的時間比例超出可校正範圍，請核對取樣率或重新準備錄音');
  calibration({scale, offset});
  const maxResidual = Math.max(...points.map(p => Math.abs(p.time - (p.raw * scale + offset))));
  if (maxResidual > 0.35) throw new Error('各定位點的偏移不一致，無法套用整體校正；請檢查切段交界或重新選擇定位點');
  return {scale: round(scale), offset: round(offset), maxResidual: round(maxResidual),
    anchors: points.map(({wordId, edge, time}) => ({wordId, edge, time}))};
}

function timingDiagnostics(recording, analysis, playerDuration) {
  const issues = [];
  let previous = -Infinity, invalidWords = 0, unorderedWords = 0;
  for (const word of analysis?.words || []) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start || word.end > recording.duration + 0.1) invalidWords++;
    if (word.start < previous) unorderedWords++;
    previous = word.start;
  }
  if (invalidWords) issues.push(`${invalidWords} 個辨識詞的時間超出音訊範圍`);
  if (unorderedWords) issues.push(`${unorderedWords} 個辨識詞的順序需要核對`);
  if (Number.isFinite(playerDuration) && Math.abs(playerDuration - recording.duration) > 0.25)
    issues.push('原檔播放長度與分析長度不同，請核對開頭、中間及結尾');
  if (recording.source === 'local' && !analysis?.clockVersion) issues.push('這份舊分析沒有保存逐段時間核對資料，可用下方定位點核對');
  if (Math.abs(recording.decoderClock?.firstTimestamp || 0) > 0.25) issues.push('來源音軌的起點不是零，請核對它與播放器的起點');
  for (const chunk of analysis?.clocks || []) {
    if (Number.isFinite(chunk.providerDuration) && Math.abs(chunk.providerDuration - chunk.sampleCount / 16000) > 0.25)
      issues.push(`第 ${chunk.index + 1} 段辨識長度與送出的音訊不同`);
  }
  return {analysisDuration: recording.duration, playerDuration: playerDuration || playbackDuration(recording),
    calibration: recording.timeCalibration || {scale: 1, offset: 0, anchors: []},
    wordCount: analysis?.words?.length || 0, invalidWords, unorderedWords,
    decoderClock: recording.decoderClock || null,
    clockVersion: analysis?.clockVersion || 0, chunks: analysis?.clocks?.length || 0, issues};
}
module.exports = {calibration, toPlayback, toAnalysis, playbackDuration, timedWords, fitCalibration, timingDiagnostics};
