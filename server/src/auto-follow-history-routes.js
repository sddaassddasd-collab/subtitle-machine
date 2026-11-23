const {createHash} = require('node:crypto');
const {createHistoryReport, historyCsv} = require('./auto-follow-history-report');

const PAGE_SIZE = 40;
const listFields = ({contextId, cellName, at}) => ({contextId, cellName, at});

function matchesRow(row, contextId, filter) {
  if (contextId !== 'all' && row.contextId !== contextId) return false;
  if (filter === 'unentered') return row.type !== 'direction' && !row.entryCount;
  if (filter === 'pending') return row.type !== 'direction' && row.visits.some(visit => !visit.confirmations.length);
  if (filter === 'manual') return row.visits.some(visit => visit.source === 'manual');
  return true;
}

function previewEvent(event) {
  const {id, at, type, index, source, status, mode, message, text, reason, note, acoustic, workerTiming, samples} = event;
  return {id, at, type, index, source, status, mode, message, text, reason, note, acoustic, workerTiming,
    sampleCount: samples?.length ?? event.sampleCount,
    ...(type === 'tracking_comparison' && event.display?.manualBackground ? {manualComparison: {
      displayIndex: event.display.index, candidateIndex: event.locator?.candidate?.index,
      locatedIndex: event.locator?.accepted ? event.locator.index : null,
      reliable: event.locator?.reliable === true, delayMs: event.delayFromManualMs,
      text: event.locator?.evidence?.text, reason: event.locator?.reason,
    }} : {})};
}

async function writeChunk(res, chunk) {
  if (res.destroyed) return false;
  if (!res.write(chunk) && !res.destroyed) await new Promise(resolve => {
    const done = () => { res.off('drain', done); res.off('close', done); res.off('error', done); resolve(); };
    res.once('drain', done); res.once('close', done); res.once('error', done);
  });
  return !res.destroyed;
}

async function streamJson(res, run, events) {
  const result = createHistoryReport(run);
  if (!await writeChunk(res, '{"events":[')) return;
  let first = true, lastSequence = 0;
  for await (const event of events) {
    if (res.destroyed) return;
    result.add(event);
    if (!await writeChunk(res, (first ? '' : ',') + JSON.stringify(event))) return;
    first = false;
    lastSequence = event.sequence;
  }
  // A concurrent removal must not produce a successful partial download.
  if (Number.isSafeInteger(run.nextSequence) && lastSequence !== run.nextSequence - 1)
    throw new Error('匯出期間紀錄已變更，請重新下載');

  const {rows, contexts, streams, ...metadata} = result.finish();
  if (!await writeChunk(res, '],' + JSON.stringify(metadata).slice(1, -1))) return;
  for (const [key, entries] of Object.entries({rows, contexts, streams})) {
    if (!await writeChunk(res, `,"${key}":[`)) return;
    for (const [index, item] of entries.entries()) {
      if (!await writeChunk(res, (index ? ',' : '') + JSON.stringify(item))) return;
    }
    if (!await writeChunk(res, ']')) return;
  }
  res.end('}');
}

function registerAutoFollowHistoryRoutes(app, {history, requireAuth, ownedSession, broadcast, snapshot = () => null}) {
  const root = '/api/session/:sessionId/follow-history';
  const wrap = work => async (req, res) => {
    const session = ownedSession(req, res); if (!session) return;
    res.set('Cache-Control', 'no-store');
    try { await work(req, res, session); }
    catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      res.status(error.status || 503).json({error: error.message || '歷程讀取失敗，請稍後重試'});
    }
  };
  app.get(root, requireAuth, wrap(async (req, res, session) => {
    const offset = Math.min(1000000, Math.max(0, Number.parseInt(req.query.offset, 10) || 0));
    const runs = await history.list(session.id, 21, offset);
    res.json({runs: runs.slice(0, 20), hasMore: runs.length > 20, status: history.status(session.id)});
  }));
  app.post(`${root}/start`, requireAuth, wrap(async (_req, res, session) => {
    if (session.status === 'ended') return res.status(409).json({error: '活動已結束'});
    const id = await history.start(session, {fresh: true});
    await history.flush(session.id); broadcast(session.id); res.json({id});
  }));
  // Authenticated session ownership is sufficient: a failed audio connection
  // must be able to report before its replacement stream exists.
  app.post(`${root}/capture-health`, requireAuth, wrap(async (req, res, session) => {
    const accepted = await history.clientHealth(session.id, req.body?.events);
    await history.flush(session.id);
    res.json({accepted});
  }));
  app.post(`${root}/:runId/end`, requireAuth, wrap(async (req, res, session) => {
    const run = await history.requestEnd(session.id, req.params.runId);
    const ending = run.endedAt === null;
    res.status(ending ? 202 : 200).json({ok: true, ending, endedAt: run.endedAt});
  }));
  app.post(`${root}/:runId/mark`, requireAuth, wrap(async (req, res, session) => {
    const at = await history.mark(session, req.params.runId, {state: snapshot(session), note: String(req.body?.note || '').slice(0, 300)});
    await history.flush(session.id);
    res.json({ok: true, at});
  }));
  app.get(`${root}/:runId`, requireAuth, wrap(async (req, res, session) => {
    const {format} = req.query;
    if (format !== undefined && !['csv', 'json'].includes(format))
      return res.status(400).json({error: '不支援的匯出格式'});
    const run = await history.snapshot(session.id, req.params.runId, {exportDiagnostics: Boolean(format)});
    if (!run) return res.status(404).json({error: '找不到這次跟戲紀錄'});
    if (res.destroyed) return;

    if (format) {
      res.attachment(`follow-${run.id}.${format}`);
      res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json');
    }
    if (format === 'json') return streamJson(res, run, history.events(run));

    const page = Math.max(0, Number.parseInt(req.query.page, 10) || 0);
    const filter = ['unentered', 'pending', 'manual'].includes(req.query.filter) ? req.query.filter : 'all';
    const contextId = typeof req.query.contextId === 'string' ? req.query.contextId : 'all';
    if (!format) {
      const tag = '"' + createHash('sha256').update(JSON.stringify(
        [run.id, run.nextSequence, run.updatedAt, run.endedAt, run.finishRequestedAt, page, filter, contextId])).digest('hex') + '"';
      res.set('ETag', tag);
      if (req.get('If-None-Match') === tag) return res.status(304).end();
    }

    const result = createHistoryReport(run, 'summary');
    for await (const event of history.events(run, {reportOnly: true})) {
      if (res.destroyed) return;
      result.add(event);
    }
    const report = result.finish();
    if (format === 'csv') return res.send(historyCsv(report));

    const rows = report.rows.filter(row => matchesRow(row, contextId, filter));
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const index = Math.min(page, pageCount - 1);
    const recentEvents = [];
    for await (const event of history.events(run, {recent: true})) {
      if (res.destroyed) return;
      if (event.type !== 'context') recentEvents.push(previewEvent(event));
    }
    res.json({...report, rows: rows.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE),
      contexts: report.contexts.map(listFields), pagination: {page: index, pageCount, rowCount: rows.length},
      recentEvents, status: history.status(session.id)});
  }));
  app.delete(`${root}/:runId`, requireAuth, wrap(async (req, res, session) => {
    const run = await history.snapshot(session.id, req.params.runId);
    if (!run) return res.status(404).json({error: '找不到這次跟戲紀錄'});
    if (run.endedAt === null) return res.status(409).json({error: '請先結束本次紀錄再刪除'});
    await history.remove(session.id, req.params.runId); res.json({ok: true});
  }));
}
module.exports = {registerAutoFollowHistoryRoutes};
