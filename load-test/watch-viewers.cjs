// Read-only audience load test. Uses the same Socket.IO defaults as ViewerPage.
const { io } = require('../client/node_modules/socket.io-client');
const fs = require('node:fs');
const path = require('node:path');
const target = process.env.TARGET || 'https://subtitle-machine.onrender.com';
const viewerToken = process.env.VIEWER_TOKEN || 'Xh_eF4Gg_0h_MJvsXPdFOrFW';
const count = Number(process.env.ARRIVAL_COUNT || 80);
const holdMs = Number(process.env.HOLD_SECONDS || 300) * 1000;
const rampMs = Number(process.env.RAMP_SECONDS || 20) * 1000;
const started = Date.now();
const report = { target, startedAt: new Date(started).toISOString(), count, holdMs, rampMs,
  viewers: [], health: [], errors: [], samples: [], updates: {} };
const sockets = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let finishing = false;
let healthTimer;
let sampleTimer;
let joinedAt;
const reportPath = path.join(__dirname, 'reports', `${count}-watch-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
function sample() {
  const result = { elapsedSeconds: Math.round((Date.now() - started) / 1000),
    connected: sockets.filter(s => s.connected).length,
    initialized: report.viewers.filter(v => v.initialStateMs !== undefined).length,
    disconnects: report.viewers.reduce((n, v) => n + v.disconnects, 0), errors: report.errors.length };
  report.samples.push(result);
  console.log(JSON.stringify(result));
}
async function health() {
  const start = Date.now();
  try {
    const response = await fetch(`${target}/healthz`, { signal: AbortSignal.timeout(5000) });
    await response.text();
    report.health.push({ at: new Date(start).toISOString(), ms: Date.now() - start, status: response.status });
  } catch (error) {
    report.health.push({ at: new Date(start).toISOString(), ms: Date.now() - start, error: error.message });
  }
}
function finish(reason) {
  if (finishing) return;
  finishing = true;
  clearInterval(healthTimer);
  clearInterval(sampleTimer);
  sample();
  report.finishedAt = new Date().toISOString();
  report.reason = reason;
  report.fullCohortHoldSeconds = joinedAt ? (Date.now() - joinedAt) / 1000 : 0;
  report.finalConnected = sockets.filter(s => s.connected).length;
  report.transports = sockets.reduce((result, s) => {
    const name = s.io.engine?.transport?.name || 'closed';
    result[name] = (result[name] || 0) + 1;
    return result;
  }, {});
  sockets.forEach(s => s.disconnect());
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`REPORT ${reportPath}`);
}
async function addViewer(index) {
  const viewer = { index, connects: 0, disconnects: 0, updates: 0 };
  report.viewers.push(viewer);
  const start = Date.now();
  try {
    const response = await fetch(`${target}/api/viewer/${encodeURIComponent(viewerToken)}`, { signal: AbortSignal.timeout(15000) });
    viewer.httpStatus = response.status;
    const payload = await response.json();
    viewer.httpMs = Date.now() - start;
    if (!response.ok || !payload.sessionId) throw new Error(`Viewer unavailable: ${response.status}`);
    const socket = io(target, { autoConnect: false });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Initial subtitle timeout')), 20000);
      socket.on('connect', () => {
        viewer.connects += 1;
        socket.emit('join', { viewerToken, role: 'viewer' });
        socket.emit('viewer:live-language', { languageCode: 'source' });
      });
      socket.on('viewer:update', payload => {
        viewer.updates += 1;
        if (viewer.initialStateMs === undefined) {
          viewer.initialStateMs = Date.now() - start;
          clearTimeout(timeout);
          resolve();
        }
        const key = String(payload.viewerRevision ?? payload.revision ?? 'unknown');
        const entry = report.updates[key] ||= { firstAt: Date.now(), lastAt: Date.now(), viewers: [] };
        entry.lastAt = Date.now();
        if (!entry.viewers.includes(index)) entry.viewers.push(index);
      });
      socket.on('disconnect', reason => {
        if (!finishing) {
          viewer.disconnects += 1;
          report.errors.push({ index, event: 'disconnect', reason, at: new Date().toISOString() });
        }
      });
      socket.on('connect_error', error => report.errors.push({ index, event: 'connect_error', reason: error.message }));
      socket.on('viewer:expired', () => {
        clearTimeout(timeout);
        reject(new Error('Viewer session expired'));
      });
      socket.connect();
    });
  } catch (error) {
    report.errors.push({ index, event: 'initialization', reason: error.message });
  }
}
process.on('SIGINT', () => { finish('interrupted'); process.exit(130); });
process.on('SIGTERM', () => { finish('terminated'); process.exit(143); });
(async () => {
  await health();
  healthTimer = setInterval(health, 5000);
  sampleTimer = setInterval(sample, 15000);
  const pending = [];
  for (let i = 0; i < count; i += 1) {
    pending.push(addViewer(i));
    await sleep(rampMs / count);
  }
  await Promise.all(pending);
  joinedAt = Date.now();
  sample();
  if (sockets.filter(s => s.connected).length !== count || report.viewers.some(v => v.initialStateMs === undefined)) {
    finish('initialization_failed');
    process.exitCode = 1;
    return;
  }
  await sleep(holdMs);
  await health();
  finish('completed');
})().catch(error => { report.errors.push({ event: 'fatal', reason: error.message }); finish('failed'); process.exitCode = 1; });
