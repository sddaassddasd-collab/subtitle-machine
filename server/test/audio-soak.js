// Sustained local load with real HTTP health checks and application audio/ASR
// handlers. Provider transports are simulated; no credentials or store needed.
const assert = require('node:assert/strict');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const createFixture = require('./helpers/audio-server-fixture');

async function main() {
  const fixture = createFixture();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  const timers = [];
  let failure;
  let sequence = 0;
  let hypotheses = 0;
  const healthTimes = [];
  const audio = Buffer.alloc(960, 1).toString('base64');
  try {
    await new Promise((resolve, reject) => {
      fixture.server.once('error', reject);
      fixture.server.listen(0, '127.0.0.1', resolve);
    });
    const base = `http://127.0.0.1:${fixture.server.address().port}`;
    const guard = callback => () => {
      try { callback(); } catch (error) { failure ||= error; }
    };
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    eventLoop.enable();
    timers.push(setInterval(guard(() => {
      const result = fixture.send({
        sessionId: fixture.session.id, audio, sequence: ++sequence,
        durationMs: 20, level: 0.001,
      });
      assert.equal(result.ok, true);
    }), 20));
    timers.push(setInterval(guard(() => {
      const i = ++hypotheses;
      // Alternate a known cue with an unrelated phrase to exercise both the
      // nearby search and whole-script reacquisition during continuous audio.
      fixture.transcript(i % 10 < 5 ? fixture.session.lines[0].text : '窗外的紫色蝴蝶飛過陌生的海洋', {
        streamId: 'soak', itemId: `segment-${Math.floor(i / 10)}`,
        startMs: Math.floor(i / 10) * 1000, endMs: i * 100, isFinal: i % 10 === 9,
      });
    }), 100));
    for (let second = 0; second < 60; second++) {
      await delay(1000);
      if (failure) throw failure;
      const healthStart = performance.now();
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'ok');
      healthTimes.push(performance.now() - healthStart);
    }
    const elapsedMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    assert.deepEqual(fixture.counts(), { structures: 0, lines: 0 });
    assert.ok(sequence >= 2500, 'audio should sustain close to 50 packets/second');
    console.log(JSON.stringify({
      elapsedMs: Math.round(elapsedMs), audioPackets: sequence, hypotheses,
      healthChecks: healthTimes.length, maxHealthMs: +Math.max(...healthTimes).toFixed(1),
      maxEventLoopDelayMs: +(eventLoop.max / 1e6).toFixed(1),
      cpuPercent: +((cpu.user + cpu.system) / (elapsedMs * 10)).toFixed(1),
      normalizations: fixture.counts(),
    }, null, 2));
  } finally {
    timers.forEach(clearInterval);
    eventLoop.disable();
    fixture.dispose();
    await new Promise(resolve => fixture.server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
