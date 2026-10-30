const {historyReport, historyCsv} = require('./auto-follow-history-report');

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
  app.post(`${root}/:runId/end`, requireAuth, wrap(async (req, res, session) => {
    await history.end(session.id, 'user_finished', req.params.runId);
    broadcast(session.id); res.json({ok: true});
  }));
  app.post(`${root}/:runId/mark`, requireAuth, wrap(async (req, res, session) => {
    const at = await history.mark(session, req.params.runId, {state: snapshot(session), note: String(req.body?.note || '').slice(0, 300)});
    await history.flush(session.id);
    res.json({ok: true, at});
  }));
  app.get(`${root}/:runId`, requireAuth, wrap(async (req, res, session) => {
    const data = await history.read(session.id, req.params.runId, {summary: req.query.format !== 'json'});
    if (!data) return res.status(404).json({error: '找不到這次跟戲紀錄'});
    const report = historyReport(data);
    if (req.query.format) {
      if (!['csv', 'json'].includes(req.query.format)) return res.status(400).json({error: '不支援的匯出格式'});
      const format = req.query.format;
      res.attachment(`follow-${data.run.id}.${format}`);
      res.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json');
      if (format === 'csv') return res.send(historyCsv(report));
      // Write one event at a time: a long run must not allocate a second giant
      // pretty-printed JSON string while its decoded events are already loaded.
      const {events, ...metadata} = report;
      res.write(JSON.stringify(metadata).slice(0, -1) + ',"events":[');
      for (let index = 0; index < events.length; index++) {
        if (res.destroyed) return;
        if (!res.write((index ? ',' : '') + JSON.stringify(events[index]))) await new Promise(resolve => {
          const done = () => { res.off('drain', done); res.off('close', done); res.off('error', done); resolve(); };
          res.once('drain', done); res.once('close', done); res.once('error', done);
        });
      }
      return res.end(']}');
    }
    const {events, contexts, ...summary} = report;
    res.json({...summary, contexts: contexts.map(({lines: _lines, ...context}) => context),
      recentEvents: events.filter(event => event.type !== 'context').slice(-80).reverse(), status: history.status(session.id)});
  }));
  app.delete(`${root}/:runId`, requireAuth, wrap(async (req, res, session) => {
    const data = await history.read(session.id, req.params.runId, {summary: true});
    if (!data) return res.status(404).json({error: '找不到這次跟戲紀錄'});
    await history.remove(session.id, req.params.runId); res.json({ok: true});
  }));
}
module.exports = {registerAutoFollowHistoryRoutes};
