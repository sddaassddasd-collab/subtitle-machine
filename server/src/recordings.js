const {alignSegments, hashText} = require('./recording-alignment');
const {playbackDuration} = require('./recording-timing');
const {normalizePerformanceLanguage, getFollowingLines, describeFollowingScript, isRecordingCompatible} = require('./performance-language');
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_RECORDINGS = 5;
const {ACOUSTIC_SETTINGS} = require('./follow-settings');
function segmentEligibility(segment, line, recording) {
  if (!line) return 'line_missing';
  if (line.type === 'direction') return 'direction';
  if (!segment) return 'segment_missing';
  if (!ACOUSTIC_SETTINGS.allowedStatuses.includes(segment.status)) return `status_${segment.status || 'missing'}`;
  if (segment.textHash !== hashText(line)) return 'text_changed';
  if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) return 'time_missing';
  if (segment.start < 0 || segment.end <= segment.start) return 'invalid_range';
  if (recording && segment.end > playbackDuration(recording)) return 'outside_recording';
  return 'usable';
}
const isUsableSegment = (segment, line, recording) => segmentEligibility(segment, line, recording) === 'usable';

function normalizeRecordings(session) {
  if (!Array.isArray(session.recordings)) session.recordings = [];
  session.recordings = session.recordings.filter(recording => recording && typeof recording.id === 'string')
    .slice(0, MAX_RECORDINGS).map(recording => {
      recording.name = String(recording.name || recording.originalName || '參考錄音').slice(0, 120);
      recording.segments = Array.isArray(recording.segments) ? recording.segments.filter(s => s && typeof s.lineId === 'string') : [];
      recording.revision = Number.isSafeInteger(recording.revision) ? recording.revision : 1;
      recording.language = normalizePerformanceLanguage(recording.language);
      // Older recordings were cut against the primary column, irrespective of
      // the ASR language. Keep their calibration tied to that actual source.
      if (recording.scriptLanguageId === undefined) recording.scriptLanguageId = 'primary';
      return recording;
    });
  if (!session.recordings.some(r => r.id === session.activeRecordingId)) session.activeRecordingId = null;
  return session.recordings;
}

function recordingLines(session, recording) {
  const lines = recording.cellId === session.selectedCellId ? session.lines || []
    : session.cells?.find(cell => cell.id === recording.cellId)?.lines || [];
  return getFollowingLines(session, recording.language, lines, recording.scriptLanguageId);
}

function refreshMappings(session) {
  for (const recording of normalizeRecordings(session)) {
    const lines = new Map(recordingLines(session, recording).map(line => [line.id, line]));
    let changed = false;
    for (const segment of recording.segments) {
      const line = lines.get(segment.lineId);
      if (['auto', 'manual', 'review'].includes(segment.status) && (!line || segment.textHash !== hashText(line))) {
        segment.sourceStatus = segment.status; segment.status = 'stale'; changed = true;
      } else if (line && segment.status === 'stale' && ['auto','manual','review'].includes(segment.sourceStatus) &&
        segment.textHash === hashText(line)) {
        segment.status = segment.sourceStatus; delete segment.sourceStatus; changed = true;
      }
    }
    if (changed) recording.revision++;
  }
}

function validSegments(session, recording) {
  const byId = new Map(recording.segments.map(segment => [segment.lineId, segment]));
  return recordingLines(session, recording).flatMap((line, index) => {
    const segment = byId.get(line.id);
    return segment && isUsableSegment(segment, line, recording) ? [{...segment, index}] : [];
  });
}

function publicRecording(recording, {details = false, session} = {}) {
  const {id, name, originalName, duration, byteLength, mime, cellId, status, progress, error, createdAt, revision, language, scriptLanguageId} = recording;
  return {id, name, originalName, duration, byteLength, mime, cellId, status, progress, error, createdAt, revision, language, scriptLanguageId,
    ...(recording.source === 'local' ? {source: 'local', fingerprint: recording.fingerprint,
      chunkSeconds: recording.chunkSeconds, localRevision: recording.localRevision} : {}),
    mappedCount: recording.segments.filter(s => ['auto','manual'].includes(s.status)).length,
    usableCount: session ? validSegments(session, recording).length : undefined,
    reviewCount: recording.segments.filter(s => ['review','unmatched','stale'].includes(s.status)).length,
    playbackDuration: playbackDuration(recording), timeCalibration: recording.timeCalibration || null,
    featureCalibration: recording.featureCalibration || null,
    ...(recording.decoderClock ? {decoderClock: recording.decoderClock} : {}),
    alignmentNotice: recording.alignmentNotice || '',
    timingNotice: recording.timingNotice || '',
    ...(details ? {segments: recording.segments} : {}),
    ...(session ? {compatible: isRecordingCompatible(session, recording),
      ...(details ? {followingScript: describeFollowingScript(session, language, recordingLines(session, recording), scriptLanguageId)} : {})} : {}),
  };
}

function validateSegmentEdit(recording, line, body) {
  const start = Number(body.start), end = Number(body.end);
  if (!line) throw new Error('這格字幕已不存在');
  if (line.type !== 'direction' && !String(line.text || '').trim()) throw new Error('這格缺少錄音語言的劇本文字，請先補齊對應劇本欄');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > playbackDuration(recording) || end - start < 0.12)
    throw new Error('片段須至少 0.12 秒，起點與終點必須位於錄音範圍內');
  return {lineId: line.id, textHash: hashText(line), start, end, confidence: 1,
    status: line.type === 'direction' ? 'direction' : 'manual'};
}

module.exports = {MAX_FILE_BYTES, MAX_RECORDINGS, hashText, isUsableSegment, segmentEligibility,
  normalizeRecordings, recordingLines, refreshMappings, validSegments, publicRecording, alignSegments, validateSegmentEdit};
