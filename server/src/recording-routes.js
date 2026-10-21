const crypto = require('node:crypto');
const multer = require('multer');
const persistence = require('./persistence');
const {registerLocalRecordingRoutes} = require('./local-recording-routes');
const {runRecordingTask} = require('./recording-runtime');
const {MAX_FILE_BYTES, MAX_RECORDINGS, normalizeRecordings, refreshMappings,
  recordingLines, publicRecording, validateSegmentEdit, hashText} = require('./recordings');
const {SOURCE_LANGUAGES, supportedLanguage, normalizePerformanceLanguage, resolveFollowingLanguage,
  describeFollowingScript, isRecordingCompatible} = require('./performance-language');

function registerRecordingRoutes(app, {requireAuth, ownedSession, sessions, persist, broadcast, invalidate,
  storage = persistence, task = runRecordingTask, request = fetch} = {}) {
  const jobs = new Map();
  let uploading = 0;
  // The source file has a byte limit; decoded PCM must not impose a time limit.
  const upload = multer({storage: {
    _handleFile(_req, file, done) {
      const chunks = [];
      let size = 0, settled = false;
      file.stream.on('data', chunk => {
        if (settled) return;
        size += chunk.length;
        if (file.fieldname === 'audio' && size > MAX_FILE_BYTES) {
          settled = true; chunks.length = 0;
          done(new multer.MulterError('LIMIT_FILE_SIZE', file.fieldname)); return;
        }
        chunks.push(chunk);
      });
      file.stream.on('end', () => {
        if (settled) return;
        settled = true;
        let buffer;
        try { buffer = Buffer.concat(chunks, size); }
        catch (error) { chunks.length = 0; done(error); return; }
        chunks.length = 0; done(null, {buffer, size});
      });
      // Multer handles stream errors and decrements its pending write count.
      file.stream.on('error', () => { settled = true; chunks.length = 0; });
    },
    _removeFile(_req, file, done) { delete file.buffer; done(null); },
  }, limits: {
    files: 2, fields: 4, fieldSize: 1024,
  }}).fields([{name: 'audio', maxCount: 1}, {name: 'pcm', maxCount: 1}]);
  const sessionFor = (req, res, next) => {
    const session = ownedSession(req, res);
    if (!session) return;
    normalizeRecordings(session); req.recordingSession = session; next();
  };
  const wrap = handler => async (req, res) => {
    try { await handler(req, res); } catch (error) {
      res.status(400).json({error: error.message || '錄音操作失敗'});
    }
  };
  const find = (req, res) => {
    const recording = req.recordingSession.recordings.find(r => r.id === req.params.recordingId);
    if (!recording) { res.status(404).json({error: '找不到錄音'}); return null; }
    return recording;
  };
  const save = async session => { refreshMappings(session); await persist(session); broadcast(session.id); };
  const localRecordings = registerLocalRecordingRoutes(app, {
    requireAuth, sessionFor, wrap, save, find, jobs, storage, task, request, invalidate, sessions,
  });

  async function processRecording(sessionId, recordingId, uploadedAsset = null) {
    const session = sessions.get(sessionId), recording = session?.recordings.find(r => r.id === recordingId);
    if (!recording || jobs.has(recordingId)) return;
    const job = {abort: new AbortController(), sessionId}; jobs.set(recordingId, job);
    const current = () => sessions.get(sessionId)?.recordings.find(r => r.id === recordingId);
    const check = () => { if (job.abort.signal.aborted || !current()) throw new Error('錄音處理已取消'); };
    const analysisTimeoutMs = Math.max(180000, Math.ceil(recording.duration * 100));
    const transcriptionTimeoutMs = Math.max(600000, Math.ceil(recording.duration * 1000));
    try {
      let asset = uploadedAsset || await storage.getRecordingAsset(sessionId, recordingId, {audio: true, pcm: true}); check();
      if (!asset) throw new Error('音檔不存在，請重新匯入');
      recording.status = 'analysing'; recording.progress = 15; recording.error = '';
      await save(session);
      if (!asset.features) {
        if (!asset.pcm) throw new Error('缺少音訊分析資料，請重新匯入');
        const extracted = await task({type: 'extract', pcm: asset.pcm}, analysisTimeoutMs, job.abort.signal); check();
        asset.pcm = null;
        asset.features = Buffer.from(extracted.features);
        asset.analysis = {...asset.analysis, peaks: extracted.peaks, frameMs: extracted.frameMs};
        await storage.updateRecordingAnalysis(sessionId, recordingId, asset.features, asset.analysis); check();
      }
      recording.progress = 45;
      const cachedLanguage = asset.analysis.transcriptionLanguage || recording.transcriptCacheLanguage || recording.language;
      let words = cachedLanguage === recording.language ? asset.analysis.words : null;
      if (!words?.length) {
        const apiKey = String(process.env.DEEPGRAM_API_KEY || '').trim();
        if (!apiKey) {
          recording.status = 'ready'; recording.progress = 100;
          recording.error = '尚未設定 Deepgram 金鑰，可先手動標記片段；設定後再按「自動切段」。';
          await save(session); return;
        }
        recording.status = 'transcribing'; await save(session);
        const query = new URLSearchParams({model: 'nova-3', language: recording.language || session.transcriptionLanguage || 'zh-TW',
          punctuate: 'true', smart_format: 'true', mip_opt_out: 'true'});
        const timeout = setTimeout(() => job.abort.abort(), transcriptionTimeoutMs);
        let result;
        try {
          const response = await request(`https://api.deepgram.com/v1/listen?${query}`, {
          method: 'POST', headers: {'Content-Type': recording.mime, Authorization: `Token ${apiKey}`},
          body: asset.audio, signal: job.abort.signal,
          });
          if (!response.ok) throw new Error(`Deepgram 錄音辨識失敗（${response.status}），可手動設定片段或稍後再試`);
          result = await response.json();
        } finally { clearTimeout(timeout); }
        check();
        words = result.results?.channels?.[0]?.alternatives?.[0]?.words || [];
        if (!words.length) throw new Error('錄音未辨識出可對齊的台詞，請試聽並手動設定片段');
        asset.analysis.words = words;
        asset.analysis.transcriptionLanguage = recording.language;
        await storage.updateRecordingAnalysis(sessionId, recordingId, null, asset.analysis); check();
      }
      recording.transcriptCacheLanguage = recording.language;
      recording.progress = 75; await save(session);
      const script = recordingLines(session, recording).map(line => ({id: line.id, text: line.text, type: line.type}));
      const aligned = await task({type: 'align', lines: script, words, duration: recording.duration, features: asset.features}, analysisTimeoutMs, job.abort.signal); check();
      const latestLines = new Map(recordingLines(session, recording).map(line => [line.id, line]));
      recording.segments = aligned.segments.map(segment => segment.textHash === hashText(latestLines.get(segment.lineId))
        ? segment : {...segment, status: 'stale'});
      recording.revision++; recording.status = 'ready'; recording.progress = 100;
      recording.error = ''; invalidate(sessionId);
      await save(session);
    } catch (error) {
      if (current()) {
        recording.status = 'error'; recording.error = error.name === 'AbortError' ? '錄音辨識超時，請稍後再試或先手動標記片段' : error.message;
        recording.progress = 0; await save(session).catch(() => {});
      }
    } finally { jobs.delete(recordingId); }
  }

  app.get('/api/session/:sessionId/recordings', requireAuth, sessionFor, wrap(async (req, res) => {
    const session = req.recordingSession; refreshMappings(session);
    res.json({recordings: session.recordings.map(r => publicRecording(r, {details: true, session})),
      activeRecordingId: session.activeRecordingId, canTranscribe: Boolean(String(process.env.DEEPGRAM_API_KEY || '').trim()),
      performanceLanguage: session.transcriptionLanguage, sourceLanguages: SOURCE_LANGUAGES,
      followingScript: describeFollowingScript(session),
      limits: {maxFileBytes: MAX_FILE_BYTES, maxDuration: null, maxRecordings: MAX_RECORDINGS}});
  }));
  app.post('/api/session/:sessionId/recordings', requireAuth, sessionFor, (req, res, next) => {
    if (jobs.size + uploading >= 1) return res.status(409).json({error: '目前已有錄音正在處理，請稍後再匯入'});
    if (req.recordingSession.recordings.length >= MAX_RECORDINGS) return res.status(400).json({error: `每個節目最多 ${MAX_RECORDINGS} 份錄音`});
    uploading++;
    let released = false;
    const release = () => { if (!released) { uploading--; released = true; } };
    res.once('finish', release); res.once('close', release);
    upload(req, res, error => { if (error) res.status(400).json({error: '上傳格式或大小不符合限制'}); else next(); });
  }, wrap(async (req, res) => {
    const session = req.recordingSession, audio = req.files?.audio?.[0], pcm = req.files?.pcm?.[0];
    if (!audio?.buffer.length || audio.size > MAX_FILE_BYTES || !pcm?.buffer.length || pcm.size % 2)
      throw new Error('請提供可解碼的錄音與單聲道 PCM 資料');
    const duration = pcm.size / 2 / 16000;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('音檔沒有可讀取的錄音內容');
    const mime = audio.mimetype;
    if (!/^audio\/(mpeg|mp3|wav|x-wav|wave|mp4|m4a|x-m4a|aac|ogg|webm|flac|x-flac|aiff|x-aiff)$/.test(mime))
      throw new Error('請使用 MP3、WAV、M4A 或瀏覽器可解碼的音訊檔');
    const cellId = req.body.cellId || session.selectedCellId;
    if (!session.cells.some(cell => cell.id === cellId)) throw new Error('找不到指定場次');
    if (req.body.language && !supportedLanguage(req.body.language)) throw new Error('不支援此錄音語言');
    const language = normalizePerformanceLanguage(req.body.language || session.transcriptionLanguage);
    const scriptLanguageId = resolveFollowingLanguage(session, language).languageId;
    const recording = {id: crypto.randomUUID(), name: String(req.body.name || audio.originalname).slice(0,120),
      originalName: audio.originalname.slice(0,160), mime, byteLength: audio.size, duration,
      cellId, status: 'analysing', progress: 0, error: '', revision: 1,
      language, scriptLanguageId, createdAt: Date.now(), segments: []};
    recording.segments = recordingLines(session, recording).map(line => ({lineId: line.id, textHash: hashText(line),
      start: null, end: null, confidence: 0, status: line.type === 'direction' ? 'direction' : 'unmatched'}));
    await storage.putRecordingAsset(session.id, recording.id, {audio: audio.buffer, pcm: pcm.buffer, analysis: {}});
    session.recordings.push(recording);
    try { await save(session); } catch (error) {
      session.recordings = session.recordings.filter(r => r.id !== recording.id);
      await storage.deleteRecordingAssets(session.id, recording.id); throw error;
    }
    res.status(202).json({recording: publicRecording(recording, {details: true, session})});
    void processRecording(session.id, recording.id, {audio: audio.buffer, pcm: pcm.buffer, features: null, analysis: {}});
  }));
  app.post('/api/session/:sessionId/recordings/:recordingId/align', requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = find(req, res); if (!recording) return;
    if (recording.source === 'local') {
      if (jobs.size || localRecordings.writing(recording.id)) throw new Error('錄音正在處理中');
      recording.scriptLanguageId = resolveFollowingLanguage(req.recordingSession, recording.language).languageId;
      recording.revision++; invalidate(req.recordingSession.id);
      res.status(202).json({ok: true}); void localRecordings.align(req.recordingSession, recording); return;
    }
    if (jobs.size + uploading >= 1 || jobs.has(recording.id)) return res.status(409).json({error: '錄音正在處理中'});
    recording.scriptLanguageId = resolveFollowingLanguage(req.recordingSession, recording.language).languageId;
    recording.revision++; invalidate(req.recordingSession.id);
    res.status(202).json({ok: true}); void processRecording(req.recordingSession.id, recording.id);
  }));
  app.put('/api/session/:sessionId/recordings/:recordingId/language', requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = find(req, res); if (!recording) return;
    const language = supportedLanguage(req.body.language)?.code;
    if (!language) throw new Error('不支援此錄音語言');
    if (jobs.size + uploading >= 1) return res.status(409).json({error: '錄音正在處理中，完成後再修改語言'});
    const session = req.recordingSession;
    if (language === recording.language) return res.json({recording: publicRecording(recording, {details: true, session})});
    if (recording.source === 'local') {
      await localRecordings.changeLanguage(session, recording, language);
      return res.json({recording: publicRecording(recording, {details: true, session})});
    }
    const previous = {...recording}, active = session.activeRecordingId;
    recording.transcriptCacheLanguage ||= recording.language;
    recording.language = language; recording.scriptLanguageId = resolveFollowingLanguage(session, language).languageId;
    recording.revision++; recording.status = 'analysing'; recording.progress = 0; recording.error = '';
    recording.segments = recordingLines(session, recording).map(line => ({lineId: line.id, textHash: hashText(line),
      start: null, end: null, confidence: 0, status: line.type === 'direction' ? 'direction' : 'unmatched'}));
    if (active === recording.id) session.activeRecordingId = null;
    try { await save(session); } catch (error) { Object.assign(recording, previous); session.activeRecordingId = active; throw error; }
    invalidate(session.id);
    res.status(202).json({recording: publicRecording(recording, {details: true, session})});
    void processRecording(session.id, recording.id);
  }));
  app.put('/api/session/:sessionId/recordings/active', requireAuth, sessionFor, wrap(async (req, res) => {
    const session = req.recordingSession, id = req.body.recordingId;
    if (id !== null && !session.recordings.some(r => r.id === id && r.status === 'ready' && r.cellId === session.selectedCellId))
      throw new Error('請選擇目前場次已完成處理的錄音');
    if (id !== null) {
      const recording = session.recordings.find(r => r.id === id);
      if (!isRecordingCompatible(session, recording)) throw new Error('錄音語言或劇本欄與目前演出設定不同，請選擇對應錄音或重新切段');
      refreshMappings(session);
      const ids = new Set(session.lines.filter(line => line.type !== 'direction').map(line => line.id));
      if (!recording.segments.some(segment => ids.has(segment.lineId) && ['auto','manual'].includes(segment.status)))
        throw new Error('請先確認至少一個台詞片段，再啟用音訊跟戲');
    }
    const previous = session.activeRecordingId;
    session.activeRecordingId = id;
    try { await save(session); } catch (error) { session.activeRecordingId = previous; throw error; }
    invalidate(session.id); res.json({activeRecordingId: id});
  }));
  app.put('/api/session/:sessionId/recordings/:recordingId/segments/:lineId', requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = find(req, res); if (!recording) return;
    if (jobs.has(recording.id)) return res.status(409).json({error: '自動切段完成後再校正'});
    const session = req.recordingSession, line = recordingLines(session, recording).find(line => line.id === req.params.lineId);
    const segment = validateSegmentEdit(recording, line, req.body);
    const previous = recording.segments, revision = recording.revision;
    recording.segments = [...previous.filter(s => s.lineId !== segment.lineId), segment]; recording.revision++;
    try { await save(session); } catch (error) { recording.segments = previous; recording.revision = revision; throw error; }
    invalidate(session.id); res.json({segment});
  }));
  app.get('/api/session/:sessionId/recordings/:recordingId/waveform', requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = find(req, res); if (!recording) return;
    const asset = await storage.getRecordingAsset(req.recordingSession.id, recording.id, {features: false});
    if (!asset) return res.status(404).json({error: '音檔不存在，請重新匯入'});
    if (recording.source === 'local' && asset.analysis.finePeaks) {
      return res.json({...localRecordings.waveform(asset.analysis.finePeaks, recording.duration, req.query.start, req.query.end),
        featuresReady: asset.featuresReady});
    }
    res.json({peaks: asset.analysis.peaks || [], duration: recording.duration, featuresReady: asset.featuresReady});
  }));
  app.get('/api/session/:sessionId/recordings/:recordingId/audio', requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = find(req, res); if (!recording) return;
    if (recording.source === 'local') return res.status(404).json({error: '此錄音保留在本機，請在控制端連結原音檔後試聽'});
    let start = 0, end = recording.byteLength - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) return res.status(416).set('Content-Range', `bytes */${recording.byteLength}`).end();
      if (!match[1]) start = Math.max(0, recording.byteLength - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || start > end || start < 0) return res.status(416).set('Content-Range', `bytes */${recording.byteLength}`).end();
    }
    const buffer = await storage.getRecordingAudioRange(req.recordingSession.id, recording.id, start, end - start + 1);
    if (!buffer) return res.status(404).json({error: '音檔不存在，請重新匯入'});
    res.set({'Content-Type': recording.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store', 'Content-Length': String(buffer.length)});
    if (req.headers.range) res.status(206).set('Content-Range', `bytes ${start}-${end}/${recording.byteLength}`);
    res.send(buffer);
  }));
  app.delete('/api/session/:sessionId/recordings/:recordingId', requireAuth, sessionFor, wrap(async (req, res) => {
    const recording = find(req, res); if (!recording) return;
    if (localRecordings.writing(recording.id)) throw new Error('錄音片段正在保存，請稍後再移除');
    const session = req.recordingSession, previous = session.recordings, active = session.activeRecordingId;
    session.recordings = previous.filter(r => r.id !== recording.id);
    if (active === recording.id) session.activeRecordingId = null;
    try { await save(session); } catch (error) { session.recordings = previous; session.activeRecordingId = active; throw error; }
    jobs.get(recording.id)?.abort.abort(); invalidate(session.id);
    await storage.deleteRecordingAssets(session.id, recording.id);
    res.json({ok: true});
  }));
  return {jobs, cancelSession(sessionId) {
    for (const job of jobs.values()) if (job.sessionId === sessionId) job.abort.abort();
  }};
}
module.exports = {registerRecordingRoutes};
