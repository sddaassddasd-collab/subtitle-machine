const {test} = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/audio-server-fixture');
const rehearsals = require('./fixtures/location-safety-rehearsals.json');
for (const name of ['shared-forward', 'shared-prefix', 'near-suffix', 'pause-city', 'pause-body']) {
  test(`server replays recorded location safety: ${name}`, async t => {
    const scenario = rehearsals.cases.find(c => c.name === name);
    const f = fixture({texts: rehearsals.lines.map(line => line.type === 'direction' ? {...line} : line.text), allowCueChanges: true});
    t.after(() => f.dispose()); f.allowSettings();
    f.event('setCurrentIndex', {index: scenario.selectedIndex});
    for (const e of scenario.events) {
      f.stream.autoFollowAudioMs = e.audioEndMs;
      f.transcript(e.text, {itemId: e.itemId, streamId: 'provider', startMs: e.audioStartMs, endMs: e.audioEndMs,
        receivedAt: e.audioEndMs, isFinal: e.isFinal, words: e.words, order: e.order});
      if (name === 'shared-forward' && e.sequence < 11044) assert.ok(f.session.currentIndex < 206);
      if (name === 'shared-forward' && e.sequence === 10740) assert.equal(f.session.currentIndex, 199);
      if (name === 'shared-prefix' && e.sequence === 7691) assert.equal(f.session.currentIndex, 146);
      if (name === 'near-suffix' && e.sequence === 396) assert.equal(f.session.currentIndex, 4);
      if (name === 'pause-city' && e.sequence === 9539) assert.equal(f.session.currentIndex, 173);
      if (name === 'pause-body' && e.sequence === 14969) assert.equal(f.session.currentIndex, 258);
    }
    const index = f.session.currentIndex;
    for (let i = 0; i < 64; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.session.currentIndex, index, 'background tracking never changes cue output');
    assert.ok(f.shadow().last.locator.evidence);
  });
}
