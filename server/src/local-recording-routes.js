const crypto = require('node:crypto');
const express = require('express');
const {decodeFeatures} = require('./acoustic-follow');
const {recordingLines, hashText, publicRecording, MAX_RECORDINGS} = require('./recordings');
const {supportedLanguage, normalizePerformanceLanguage, resolveFollowingLanguage} = require('./performance-language');

const {analyseAlignment} = require('./recording-analysis');
const {calibration, fitCalibration} = require('./recording-timing');

const CHUNK_SECONDS = 300;
const MAX_DURATION = 12 * 3600;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const expectedFrames = duration => Math.max(0, Math.floor((Math.round(duration * 16000) - 400) / 640) + 1);
const fail = message => { throw new Error(message); };
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

function unpack(bytes, maxJson = 1024 * 1024) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 4) fail('分析資料格式錯誤');
  const size = bytes.readUInt32LE(0);
  if (size > maxJson || size + 4 > bytes.length) fail('分析資料標頭過大或不完整');
  return {metadata: JSON.parse(bytes.subarray(4, 4 + size).toString()), features: bytes.subarray(4 + size)};
}
function pack(metadata, features) {
  const json = Buffer.from(JSON.stringify(metadata)), size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  return Buffer.concat([size, json, features]);
}
function validateFeatures(features, duration) {
  const reference = decodeFeatures(features);
  if (reference.count !== expectedFrames(duration) || !reference.matrix.every(Number.isFinite)) fail('聲音特徵與片段長度不符');
}
function wordsFor(words, duration, maxWords = 20000) {
  if (!Array.isArray(words) || words.length > maxWords) fail('辨識結果過大或格式錯誤');
  return words.map(word => {
    if (typeof word.word !== 'string' || word.word.length > 512 || !finite(word.start, 0, duration + 0.1) ||
      !finite(word.end, word.start, duration + 0.1)) fail('辨識時間戳格式錯誤');
    const start = Math.min(duration, word.start), end = Math.min(duration, word.end);
    return {word: word.word, start, end,
      confidence: finite(word.confidence, 0, 1) ? word.confidence : 0,
      ...(word.timingUncertain === true || end === start || end !== word.end || start !== word.start ? {timingUncertain: true} : {})};
  });
}
function peaksFor(peaks, count) {
  if (!Array.isArray(peaks) || peaks.length !== count || !peaks.every(value => finite(value, 0, 1))) fail('波形資料格式錯誤');
  return peaks;
}
function waveform(peaks, duration, from = 0, to = duration) {
  from = Math.max(0, Math.min(duration, Number(from) || 0));
  to = Math.max(from, Math.min(duration, Number(to) || duration));
  const first = Math.floor(from * 10), last = Math.min(peaks.length, Math.ceil(to * 10));
  const stride = Math.max(1, Math.ceil((last - first) / 1600)), result = [];
  for (let index = first; index < last; index += stride) {
    let peak = 0;
    for (let i = index; i < Math.min(last, index + stride); i++) peak = Math.max(peak, peaks[i]);
    result.push(peak);
  }
  return {peaks: result, from: first / 10, peakSeconds: stride / 10, duration};
}

function registerLocalRecordingRoutes(app, context) {
  const {requireAuth, sessionFor, wrap, save, find, jobs, storage, task, request, invalidate, sessions} = context;
  const prefix = '/api/session/:sessionId/recordings';
  const tokens = new Map(), locks = new Set();
  const local = (req, res) => {
    const recording = find(req, res);
    if (!recording) return null;
    if (recording.source !== 'local') fail('此錄音不是本機錄音');
    return recording;
  };
  const metadata = (body, session) => {
    if (!body || !finite(body.duration, 0.025, MAX_DURATION) || !Number.isSafeInteger(body.byteLength) || body.byteLength <= 0 ||
      !/^[a-f0-9]{64}$/.test(body.fingerprint || '')) fail('請提供正確的本機錄音資訊（單份最長 12 小時）');
    if (body.language && !supportedLanguage(body.language)) fail('不支援此錄音語言');
    const cellId = body.cellId || session.selectedCellId;
    if (!session.cells.some(cell => cell.id === cellId)) fail('找不到指定場次');
    const language = normalizePerformanceLanguage(body.language || session.transcriptionLanguage);
    let decoderClock;
    if (body.decoderClock) {
      if (!finite(body.decoderClock.sourceSampleRate, 1000, 768000) || !finite(body.decoderClock.firstTimestamp, -86400, 86400))
        fail('音軌時間資料格式錯誤');
      decoderClock = {sourceSampleRate: body.decoderClock.sourceSampleRate, firstTimestamp: body.decoderClock.firstTimestamp};
    }
    return {source: 'local', fingerprint: body.fingerprint, duration: Math.round(body.duration * 16000) / 16000,
      byteLength: body.byteLength, mime: String(body.mime || 'audio/wav').slice(0, 100),
      name: String(body.name || '本機錄音').slice(0, 120), originalName: String(body.originalName || body.name || '本機錄音').slice(0, 160),
      cellId, language, scriptLanguageId: resolveFollowingLanguage(session, language).languageId,
      chunkSeconds: CHUNK_SECONDS, localRevision: 1, ...(decoderClock ? {decoderClock} : {})};
  };
  const counts = async (session, recording) => {
    const chunks = await storage.getRecordingChunks(session.id, recording.id);
    return chunks.filter(chunk => chunk.analysis.localRevision === recording.localRevision);
  };
  const recheck = (session, recording, revision) => {
    if (sessions.get(session.id) !== session || !session.recordings.includes(recording) || recording.localRevision !== revision)
      fail('錄音已移除或辨識設定已更新，請重新操作');
  };

  async function align(session, recording, options = {}) {
    if (jobs.size || locks.has(recording.id)) fail('目前已有錄音正在處理，請稍後再試');
    const job = {abort: new AbortController(), sessionId: session.id};
    jobs.set(recording.id, job);
    const revision = recording.localRevision;
    try {
      let asset = await storage.getRecordingAsset(session.id, recording.id);
      if (!asset?.features) {
        const chunks = await storage.getRecordingChunks(session.id, recording.id, {features: true});
        const total = Math.ceil(recording.duration / CHUNK_SECONDS);
        if (chunks.length !== total || chunks.some((chunk, index) => chunk.index !== index || chunk.analysis.localRevision !== revision))
          fail('本機錄音尚未分析完成，請連結原音檔後繼續');
        const header = Buffer.from(chunks[0].features.subarray(0, 24));
        header.writeUInt32LE(chunks.reduce((sum, chunk) => sum + chunk.features.readUInt32LE(20), 0), 20);
        const features = Buffer.concat([header, ...chunks.map(chunk => chunk.features.subarray(24))]);
        validateFeatures(features, recording.duration);
        const words = [], finePeaks = [], clocks = [];
        for (const chunk of chunks) {
          finePeaks.push(...chunk.analysis.peaks);
          if (chunk.analysis.clock) clocks.push({index: chunk.index, ...chunk.analysis.clock});
          for (const word of chunk.analysis.words) {
            const last = words.at(-1);
            if (last && last.end > last.start && word.end > word.start && last.word === word.word &&
              word.start < last.end && Math.abs(last.start - word.start) < 0.4) {
              last.end = Math.max(last.end, word.end);
              if (word.timingUncertain) last.timingUncertain = true;
            } else words.push({...word});
          }
        }
        asset = {features, analysis: {words, finePeaks, frameMs: 40, transcriptionLanguage: recording.language,
          transcribed: chunks.every(chunk => chunk.analysis.transcribed), localRevision: revision,
          clockVersion: clocks.length === total ? 1 : 0, clocks}};
        asset.analysis.peaks = waveform(finePeaks, recording.duration).peaks;
        recheck(session, recording, revision);
        await storage.putRecordingAsset(session.id, recording.id, {...asset, audio: null});
      }
      recheck(session, recording, revision);
      recording.status = 'analysing'; recording.progress = 95; await save(session);
      const segments = await analyseAlignment({session, recording, asset, options, task, storage, request,
        signal: job.abort.signal, check: () => { recheck(session, recording, revision); job.abort.signal.throwIfAborted(); }});
      recheck(session, recording, revision);
      recording.segments = segments;
      recording.status = 'ready'; recording.progress = 100; recording.revision++;
      recording.transcriptCacheLanguage = recording.language;
      recording.error = asset.analysis.words?.length ? '' : '尚無辨識台詞，可先試聽並手動標記；連結原音檔後可補做辨識。';
      invalidate(session.id); await save(session);
    } catch (error) {
      if (sessions.get(session.id) === session && session.recordings.includes(recording) && recording.localRevision === revision) {
        recording.status = 'interrupted'; recording.error = job.abort.signal.aborted
          ? '錄音處理已停止，原配對與校正已保留，可稍後重試' : error.message;
        await save(session).catch(() => {});
      }
      if (sessions.get(session.id) !== session || !session.recordings.includes(recording))
        await storage.deleteRecordingAssets(session.id, recording.id).catch(() => {});
    } finally { jobs.delete(recording.id); }
  }

  app.post(`${prefix}/local`, requireAuth, sessionFor, wrap(async (req, res) => {
    const session = req.recordingSession, values = metadata(req.body, session);
    const existing = session.recordings.find(recording => recording.source === 'local' && recording.fingerprint === values.fingerprint &&
      recording.cellId === values.cellId && recording.language === values.language);
    if (existing) return res.json({recording: publicRecording(existing, {details: true, session})});
    if (session.recordings.length >= MAX_RECORDINGS) fail(`每個節目最多 ${MAX_RECORDINGS} 份錄音`);
    const recording = {...values, id: crypto.randomUUID(), status: 'local', progress: 0, error: '', revision: 1,
      createdAt: Date.now(), segments: []};
    session.recordings.push(recording);
    try { await save(session); } catch (error) { session.recordings = session.recordings.filter(entry => entry !== recording); throw error; }
    res.status(201).json({recording: publicRecording(recording, {details: true, session})});
  }));
  app.get(`${prefix}/:recordingId/local/state`, requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = local(req, res); if (!recording) return;
    const chunks = await counts(req.recordingSession, recording);
    const asset = await storage.getRecordingAsset(req.recordingSession.id, recording.id, {features: false});
    res.json({localRevision: recording.localRevision, chunkSeconds: CHUNK_SECONDS, total: Math.ceil(recording.duration / CHUNK_SECONDS),
      completed: chunks.map(chunk => ({index: chunk.index, transcribed: chunk.analysis.transcribed})),
      aggregateReady: Boolean(asset?.featuresReady), transcribed: asset?.analysis.transcribed === true,
      canTranscribe: Boolean(String(process.env.DEEPGRAM_API_KEY || '').trim())});
  }));
  app.post(`${prefix}/:recordingId/local/token`, requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = local(req, res); if (!recording) return;
    res.set('Cache-Control', 'no-store');
    const key = String(process.env.DEEPGRAM_API_KEY || '').trim();
    if (!key) fail('尚未設定 Deepgram 金鑰');
    const now = Date.now(), owner = req.recordingSession.ownerUserId;
    for (const [id, bucket] of tokens) if (now - bucket.at > 60000) tokens.delete(id);
    const bucket = tokens.get(owner) || {at: now, count: 0};
    if (++bucket.count > 12) fail('辨識授權要求過於頻繁，請稍後再試');
    tokens.set(owner, bucket);
    let response;
    try {
      response = await request('https://api.deepgram.com/v1/auth/grant', {method: 'POST',
        headers: {Authorization: `Token ${key}`, 'Content-Type': 'application/json'}, body: JSON.stringify({ttl_seconds: 120}),
        signal: AbortSignal.timeout(20000)});
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      return res.status(timeout ? 504 : 502).json({error: timeout
        ? '連線至 Deepgram 授權服務逾時，請稍後再試。'
        : '後端無法連線至 Deepgram 授權服務，請檢查伺服器網路或稍後再試。'});
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const status = response.status;
      let message;
      if (status === 401) message = 'Deepgram 未接受後端金鑰（HTTP 401），請確認後端 DEEPGRAM_API_KEY 是否有效、已過期或已撤銷。';
      else if (status === 403) message = 'Deepgram 拒絕核發短期授權（HTTP 403）。請由管理員在 Deepgram API Keys → Create Key → Advanced 建立 Member 或以上權限的金鑰，更新後端 DEEPGRAM_API_KEY 並重新部署。';
      else if (status === 429) message = 'Deepgram 授權請求過於頻繁（HTTP 429），請稍後再試。';
      else if (status >= 500) message = `Deepgram 授權服務暫時異常（HTTP ${status}），請稍後再試。`;
      else message = `Deepgram 未接受短期授權請求（HTTP ${status}），請檢查後端授權設定。`;
      // Only expose a provider correlation ID. Upstream error text or headers
      // can echo credentials and must never be returned to the browser.
      const requestId = typeof result?.request_id === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(result.request_id)
        ? result.request_id : undefined;
      return res.status(status === 429 ? 429 : 502).json({error: message, providerStatus: status, requestId});
    }
    if (typeof result?.access_token !== 'string' || !result.access_token || !finite(result.expires_in, 1, 3600))
      return res.status(502).json({error: 'Deepgram 未回傳有效的短期授權，請稍後再試。'});
    res.json({token: result.access_token, expiresIn: result.expires_in});
  }));
  app.put(`${prefix}/:recordingId/local/chunks/:index`, requireAuth, sessionFor,
    express.raw({type: 'application/octet-stream', limit: MAX_CHUNK_BYTES}), wrap(async (req, res) => {
      const recording = local(req, res); if (!recording) return;
      const session = req.recordingSession, index = Number(req.params.index), revision = recording.localRevision;
      if (jobs.has(recording.id) || locks.has(recording.id)) fail('錄音正在處理，請稍後再試');
      if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(recording.duration / CHUNK_SECONDS)) fail('片段編號錯誤');
      locks.add(recording.id);
      try {
        const {metadata: body, features} = unpack(req.body);
        const start = index * CHUNK_SECONDS, end = Math.min(recording.duration, start + CHUNK_SECONDS);
        if (body.localRevision !== revision || body.language !== recording.language || body.fingerprint !== recording.fingerprint)
          fail('錄音或辨識設定不一致，請重新連結原音檔');
        validateFeatures(features, end - start);
        const words = wordsFor(body.words, recording.duration).filter(word => {
          const middle = (word.start + word.end) / 2;
          return middle >= start && (middle < end || (end === recording.duration && middle === end));
        });
        const peaks = peaksFor(body.peaks, Math.ceil(Math.round((end - start) * 16000) / 1600));
        let clock;
        if (body.clock) {
          const expectedFrom = Math.round(Math.max(0, start - 2) * 16000);
          const expectedTo = Math.round(Math.min(recording.duration, end + 2) * 16000);
          if (body.clock.sampleRate !== 16000 || body.clock.fromSample !== expectedFrom ||
            body.clock.sampleCount !== expectedTo - expectedFrom ||
            (body.clock.providerDuration !== undefined && (!finite(body.clock.providerDuration, 0, 310) ||
              Math.abs(body.clock.providerDuration - body.clock.sampleCount / 16000) > 0.25))) fail('片段時間與實際音訊長度不符，請重新準備');
          clock = {sampleRate: 16000, fromSample: expectedFrom, sampleCount: expectedTo - expectedFrom,
            ...(body.clock.providerDuration !== undefined ? {providerDuration: body.clock.providerDuration} : {})};
        }
        const analysis = {start, end, words, peaks, localRevision: revision, transcribed: body.transcribed === true,
          ...(clock ? {clock} : {})};
        await storage.putRecordingChunk(session.id, recording.id, index, features, analysis);
        recheck(session, recording, revision);
        // Any changed chunk invalidates the aggregate, but never stores PCM/audio.
        await storage.putRecordingAsset(session.id, recording.id, {audio: null, analysis: {localRevision: revision}});
        const chunks = await counts(session, recording);
        recheck(session, recording, revision);
        recording.status = 'local'; recording.progress = Math.floor(chunks.length / Math.ceil(recording.duration / CHUNK_SECONDS) * 90);
        recording.error = ''; recording.revision++; invalidate(session.id); await save(session);
        res.json({ok: true, completed: chunks.length});
      } catch (error) {
        if (sessions.get(session.id) !== session || !session.recordings.includes(recording))
          await storage.deleteRecordingAssets(session.id, recording.id).catch(() => {});
        throw error;
      } finally { locks.delete(recording.id); }
    }));
  app.post(`${prefix}/:recordingId/local/finish`, requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = local(req, res); if (!recording) return;
    if (jobs.size || locks.has(recording.id)) fail('錄音正在處理，請稍後再試');
    res.status(202).json({ok: true}); void align(req.recordingSession, recording);
  }));
  app.get(`${prefix}/:recordingId/local/export`, requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = local(req, res); if (!recording) return;
    const asset = await storage.getRecordingAsset(req.recordingSession.id, recording.id);
    if (!asset?.features || recording.status !== 'ready') fail('請先完成錄音分析');
    const data = pack({kind: 'subtitle-local-recording', version: 1,
      recording: publicRecording(recording, {details: true}), analysis: asset.analysis}, asset.features);
    res.set({'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="recording-analysis.subtitle-audio"; filename*=UTF-8''${encodeURIComponent(recording.name + '.subtitle-audio')}`}).send(data);
  }));
  app.post(`${prefix}/local/import`, requireAuth, sessionFor,
    express.raw({type: 'application/octet-stream', limit: MAX_BACKUP_BYTES}), wrap(async (req, res) => {
      const session = req.recordingSession, {metadata: body, features} = unpack(req.body, 20 * 1024 * 1024);
      if (body.kind !== 'subtitle-local-recording' || body.version !== 1) fail('不支援的錄音分析備份');
      const values = metadata({...body.recording, cellId: req.query.cellId || session.selectedCellId}, session);
      validateFeatures(features, values.duration);
      const words = wordsFor(body.analysis?.words, values.duration, 1000000);
      const finePeaks = peaksFor(body.analysis?.finePeaks, Math.ceil(Math.round(values.duration * 16000) / 1600));
      let recording = session.recordings.find(entry => entry.source === 'local' && entry.fingerprint === values.fingerprint &&
        entry.cellId === values.cellId && entry.language === values.language);
      if (recording && (jobs.has(recording.id) || locks.has(recording.id))) fail('錄音正在處理');
      if (!recording && session.recordings.length >= MAX_RECORDINGS) fail(`每個節目最多 ${MAX_RECORDINGS} 份錄音`);
      recording ||= {...values, id: crypto.randomUUID(), revision: 1, createdAt: Date.now(), segments: []};
      const importedCalibration = body.recording.timeCalibration ? calibration(body.recording.timeCalibration) : null;
      const importedFeatureCalibration = body.recording.featureCalibration ? calibration(body.recording.featureCalibration) : null;
      const importedDuration = body.recording.playbackDuration || values.duration;
      if (!finite(importedDuration, 0.025, 86400)) fail('備份播放時間格式錯誤');
      if (importedCalibration && body.recording.timeCalibration.anchors) {
        const checked = fitCalibration(body.recording.timeCalibration.anchors, words, values.duration, importedDuration);
        importedCalibration.anchors = checked.anchors;
      }
      locks.add(recording.id);
      try {
        if (!Array.isArray(body.recording.segments) || body.recording.segments.length > 100000) fail('片段標記格式錯誤');
        const lines = new Map(recordingLines(session, recording).map(line => [line.id, line]));
        const segments = body.recording.segments.filter(segment => segment && lines.has(segment.lineId) &&
          segment.textHash === hashText(lines.get(segment.lineId)) && ['auto', 'manual', 'review', 'stale', 'unmatched', 'direction'].includes(segment.status))
          .map(segment => {
            const start = finite(segment.start, 0, importedDuration) ? segment.start : null;
            const end = finite(segment.end, 0, importedDuration) ? segment.end : null;
            if (['auto', 'manual', 'review'].includes(segment.status) && (start === null || end === null || end <= start))
              fail('分析備份中的片段時間範圍錯誤');
            return {lineId: segment.lineId, textHash: segment.textHash, status: segment.status, start, end,
              confidence: finite(segment.confidence, 0, 1) ? segment.confidence : 0,
              source: ['text', 'openai'].includes(segment.source) ? segment.source : undefined,
              reviewReason: String(segment.reviewReason || '').slice(0, 500),
              ...Object.fromEntries(['wordStart', 'wordEnd', 'startChar', 'endChar'].filter(key => Number.isSafeInteger(segment[key]) && segment[key] >= 0).map(key => [key, segment[key]]))};
          });
        const analysis = {words, finePeaks, peaks: waveform(finePeaks, values.duration).peaks, frameMs: 40,
          transcriptionLanguage: values.language, transcribed: body.analysis.transcribed === true, localRevision: recording.localRevision};
        if (body.analysis.clockVersion === 1 && Array.isArray(body.analysis.clocks) &&
          body.analysis.clocks.length === Math.ceil(values.duration / CHUNK_SECONDS)) {
          analysis.clocks = body.analysis.clocks.map((clock, index) => {
            const from = Math.round(Math.max(0, index * CHUNK_SECONDS - 2) * 16000);
            const to = Math.round(Math.min(values.duration, (index + 1) * CHUNK_SECONDS + 2) * 16000);
            if (clock.index !== index || clock.sampleRate !== 16000 || clock.fromSample !== from || clock.sampleCount !== to - from)
              fail('備份片段時間格式錯誤');
            return {index, sampleRate: 16000, fromSample: from, sampleCount: to - from,
              ...(finite(clock.providerDuration, 0, 310) ? {providerDuration: clock.providerDuration} : {})};
          });
          analysis.clockVersion = 1;
        }
        await storage.putRecordingAsset(session.id, recording.id, {audio: null, features, analysis});
        if (sessions.get(session.id) !== session) {
          await storage.deleteRecordingAssets(session.id, recording.id); fail('節目已移除');
        }
        if (!session.recordings.includes(recording)) session.recordings.push(recording);
        recording.segments = segments;
        recording.timeCalibration = importedCalibration; recording.featureCalibration = importedFeatureCalibration;
        recording.playbackDuration = importedDuration;
        recording.status = 'ready'; recording.progress = 100; recording.error = ''; recording.revision++;
        invalidate(session.id); await save(session);
        res.status(201).json({recording: publicRecording(recording, {details: true, session})});
      } finally { locks.delete(recording.id); }
    }));

  async function changeLanguage(session, recording, language) {
    if (jobs.size || locks.has(recording.id)) fail('錄音正在處理');
    locks.add(recording.id);
    try {
      await storage.deleteRecordingChunks(session.id, recording.id);
      await storage.putRecordingAsset(session.id, recording.id, {audio: null, analysis: {}});
      recheck(session, recording, recording.localRevision);
      recording.language = language; recording.scriptLanguageId = resolveFollowingLanguage(session, language).languageId;
      if (recording.timeCalibration) recording.timeCalibration = {...recording.timeCalibration, anchors: []};
      recording.localRevision++; recording.revision++; recording.status = 'local'; recording.progress = 0;
      recording.segments = []; recording.error = '請連結原音檔後繼續辨識';
      if (session.activeRecordingId === recording.id) session.activeRecordingId = null;
      invalidate(session.id); await save(session);
    } finally { locks.delete(recording.id); }
  }
  return {align, changeLanguage, waveform, writing: id => locks.has(id)};
}
module.exports = {registerLocalRecordingRoutes, unpack, pack, validateFeatures, waveform, CHUNK_SECONDS, MAX_DURATION};
