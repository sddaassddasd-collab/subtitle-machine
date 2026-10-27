const crypto = require('node:crypto');
const {recordingLines, hashText} = require('./recordings');
const {playbackDuration, calibration} = require('./recording-timing');
const {improveAlignment} = require('./recording-ai-alignment');

function alignmentOptions(body, lines) {
  const options = {mode: body?.mode === 'ai' ? 'ai' : 'text'};
  if (body?.lineId) {
    const index = lines.findIndex(line => line.id === body.lineId);
    if (index < 0) throw new Error('字幕格已不存在，請重新選擇');
    options.lineIds = lines.slice(Math.max(0, index - 5), index + 6).map(line => line.id);
  }
  if (options.mode === 'ai') {
    options.apiKey = String(body?.apiKey || process.env.OPENAI_API_KEY || '').trim();
    if (!options.apiKey || options.apiKey.length > 1024) throw new Error('請先在設定填入 OpenAI 金鑰，或由後端設定 OPENAI_API_KEY');
  }
  return options;
}
function scriptVersion(session, recording) {
  return crypto.createHash('sha256').update(JSON.stringify([recording.scriptLanguageId,
    recordingLines(session, recording).map(line => [line.id, hashText(line)])])).digest('hex');
}
async function analyseAlignment({session, recording, asset, options = {}, task, storage, request, signal, check}) {
  const lines = recordingLines(session, recording).map(line => ({id: line.id, text: line.text, type: line.type}));
  const version = scriptVersion(session, recording);
  const verify = () => { check(); if (scriptVersion(session, recording) !== version) throw new Error('劇本已更新，請重新對齊；原校正已保留'); };
  calibration(recording.timeCalibration);
  const lineIds = options.lineIds;
  const result = await task({type: 'align', lines, words: asset.analysis.words || [],
    duration: playbackDuration(recording), features: asset.features, options: {
      previousSegments: recording.segments, lineIds, timeCalibration: recording.timeCalibration,
      featureCalibration: recording.featureCalibration,
      analysisDuration: recording.duration,
    }}, Math.max(180000, recording.duration * 100), signal);
  verify();
  recording.alignmentNotice = '';
  if (options.mode !== 'ai') return result.segments;
  const improved = await improveAlignment({lines, words: asset.analysis.words || [], segments: result.segments,
    duration: playbackDuration(recording), analysisDuration: recording.duration, timeCalibration: recording.timeCalibration,
    apiKey: options.apiKey, lineIds, reviewAll: Boolean(lineIds), request, signal, cache: asset.analysis.alignmentCache || {}, check: verify,
    onCache: async cache => {
      verify(); asset.analysis.alignmentCache = cache;
      await storage.updateRecordingAnalysis(session.id, recording.id, null, asset.analysis);
      verify();
    }});
  verify(); recording.alignmentNotice = improved.notice;
  return improved.segments;
}
module.exports = {alignmentOptions, analyseAlignment, scriptVersion};
