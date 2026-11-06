const {test} = require('node:test');
const assert = require('node:assert/strict');
const {OnsetReview} = require('../src/onset-review');

test('an onset is reviewed once on timeout and never turned into a confirmation by time passing', () => {
  const review = new OnsetReview();
  assert.equal(review.start(5, 'decision', 1000, 1040)[0].status, 'pending');
  assert.deepEqual(review.observe(5, 5000, {ignored: true, reason: 'before_prediction_fence'}), []);
  assert.equal(review.observe(5, 6040)[0].status, 'overdue');
  assert.deepEqual(review.observe(5, 7000), []);
  assert.equal(review.close('capture_stopped')[0].status, 'unconfirmed');
  assert.equal(review.active, null);
});
test('cross-cue text can confirm a displayed prediction, while skipped or corrected positions stay unconfirmed', () => {
  const review = new OnsetReview(); review.start(5, 'decision', 1000, 1040);
  const confirmed = review.observe(5, 2000, {index: 6, spans: [{index: 5}], reason: 'text_matched'},
    {itemId: 'a', startMs: 1100, endMs: 1900})[0];
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.reason, 'covered_before_advance');
  assert.equal(confirmed.audioEndMs, 1900);
  review.start(7, 'next', 2100, 2140);
  const left = review.observe(7, 4000, {index: 9, candidate: {index: 9, confidence: .9}})[0];
  assert.equal(left.status, 'unconfirmed'); assert.equal(left.targetIndex, 9);
  assert.equal(left.lastCandidate.confidence, .9);
});
