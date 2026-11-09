const {test} = require('node:test');
const assert = require('node:assert/strict');
const {supportedRecovery} = require('../src/supported-recovery');

for (const [name, currentIndex, endMs] of [['expired audio', 1, 10001], ['changed origin', 5, 2500]]) {
  test(`pending recovery clears on ${name} even without aligned words`, () => {
    const tracker = {supportedRecovery: {fromIndex: 1, index: 3, itemId: 'old', endMs: 2000}};
    assert.equal(supportedRecovery(tracker, {entries: []}, currentIndex,
      {text: '新的辨識文字', itemId: 'new', startMs: endMs - 500, endMs}, []), null);
    assert.equal(tracker.supportedRecovery, null);
  });
}
