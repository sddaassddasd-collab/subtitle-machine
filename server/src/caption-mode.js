const {normalizePerformanceLanguage, isRecordingCompatible} = require('./performance-language');

function getCaptionMode(session) {
  if (session.captionMode === 'live' || session.captionMode === 'script') return session.captionMode;
  return session.projectorDisplayMode === 'transcription' && session.subtitleControlMode !== 'auto' ? 'live' : 'script';
}

function enterLiveCaptions(session, language) {
  if (getCaptionMode(session) !== 'live' || !session.scriptResume) {
    session.scriptResume = {cellId: session.selectedCellId, lineId: session.lines[session.currentIndex]?.id,
      index: session.currentIndex, controlMode: session.subtitleControlMode,
      language: session.transcriptionLanguage, recordingId: session.activeRecordingId};
  }
  session.captionMode = 'live';
  session.discussionLanguage = normalizePerformanceLanguage(language || session.discussionLanguage || session.transcriptionLanguage);
  session.transcriptionLanguage = session.discussionLanguage;
  session.subtitleControlMode = 'manual';
  session.projectorDisplayMode = 'transcription';
  session.activeRecordingId = null;
}

function resumeScriptCaptions(session) {
  session.captionMode = 'script';
  const saved = session.scriptResume && typeof session.scriptResume === 'object' ? session.scriptResume : null;
  if (saved) {
    if (session.cells.some(cell => cell.id === saved.cellId)) session.selectedCellId = saved.cellId;
    const index = typeof saved.lineId === 'string' ? session.lines.findIndex(line => line.id === saved.lineId) : -1;
    const savedIndex = Number.isInteger(saved.index) ? saved.index : session.currentIndex;
    session.currentIndex = index >= 0 ? index : Math.max(0, Math.min(savedIndex || 0, session.lines.length - 1));
    const cell = session.cells.find(entry => entry.id === session.selectedCellId);
    if (cell) cell.currentIndex = session.currentIndex;
    session.subtitleControlMode = saved.controlMode === 'auto' ? 'auto' : 'manual';
    session.transcriptionLanguage = normalizePerformanceLanguage(saved.language || session.transcriptionLanguage);
    const recording = session.recordings?.find(entry => entry.id === saved.recordingId &&
      entry.cellId === session.selectedCellId && entry.status === 'ready');
    session.activeRecordingId = recording && isRecordingCompatible(session, recording) ? recording.id : null;
  }
  session.captionMode = 'script';
  session.projectorDisplayMode = 'script';
  session.scriptResume = null;
}

module.exports = {getCaptionMode, enterLiveCaptions, resumeScriptCaptions};
