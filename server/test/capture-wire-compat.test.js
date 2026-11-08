const {test} = require('node:test');
const assert = require('node:assert/strict');
const browser = require('../../client/src/lib/capture-wire.mjs');
const server = require('../src/capture-wire.mjs');

test('independently deployable browser/server wire implementations interoperate without changing PCM', () => {
  let state = 17;
  for (let run = 0; run < 100; run++) {
    const pcm = Int16Array.from({length: run % 2 ? 1920 : 960}, (_, i) => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return run < 50 ? (state & 65535) - 32768 : Math.round(1000 * Math.sin(i * Math.PI / (run + 1)));
    });
    const packet = {pcm: pcm.buffer, sequence: run + 1, capturedAt: 1794127519500, sourceEndMs: 12000, captureAgeMs: 40};
    const wire = browser.encodeAudioPacket(packet, 0xffffffff);
    assert.deepEqual(new Int16Array(server.decodeAudioPacket(wire).pcm), pcm);
    assert.deepEqual(new Int16Array(browser.decodeAudioPacket(server.encodeAudioPacket(packet, 0xffffffff)).pcm), pcm);
  }
  assert.equal(browser.AUDIO_WIRE, server.AUDIO_WIRE);
});
