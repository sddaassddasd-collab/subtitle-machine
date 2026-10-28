const {test} = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const {mergeChunkWords, restoreWordIssues, reviewWordIssues, wordIssuesFor} = require('../src/recording-word-merge');
const clockModule = import(pathToFileURL(path.resolve(__dirname, '../../client/src/lib/recording-clock.js')).href);
const word = (text, start, end, extra = {}) => ({word: text, start, end, confidence: .99, ...extra});
const chunk = (index, words = [], wordIssues = []) => ({index, analysis: {words, wordIssues}});

test('the reported word 605 in batch 2/12 is deferred and recovered from batch 3 at its absolute time', async () => {
  const {chunkClock, analyseChunkWords} = await clockModule;
  const source = Array.from({length: 604}, (_, i) => word(`詞${i}`, 2 + i * .4, 2.3 + i * .4));
  source.push(word('可是我答應過你', 303.705, 305.145));
  const original = structuredClone(source);
  const second = analyseChunkWords(source, chunkClock(3590, 300, 600), 304, {chunkIndex: 1, chunkCount: 12});
  assert.equal(second.words.length, 604); assert.equal(second.wordIssues.length, 1);
  assert.deepEqual(second.wordIssues[0], {wordIndex: 604, word: '可是我答應過你', start: 303.705, end: 305.145,
    reason: '辨識回傳的詞時間超出片段', zone: 'next'});
  assert.deepEqual(source, original);
  const third = analyseChunkWords([word('可是我答應過你', 3.705, 5.145), word('下一句', 6, 7)],
    chunkClock(3590, 600, 900), 304, {chunkIndex: 2, chunkCount: 12});
  const chunks = Array.from({length: 12}, (_, index) => chunk(index));
  chunks[1] = chunk(1, second.words, second.wordIssues); chunks[2] = chunk(2, third.words, third.wordIssues);
  const merged = mergeChunkWords(chunks, 3590);
  const recovered = merged.words.find(item => item.word === '可是我答應過你');
  assert.equal(recovered.start, 601.705); assert.equal(recovered.end, 603.145);
  assert.equal(recovered.timingUncertain, undefined); assert.equal(recovered.sourceChunk, 2);
  assert.equal(merged.words.find(item => item.word === '下一句').start, 604);
  assert.equal(merged.wordIssues[0].status, 'recovered'); assert.deepEqual(merged.wordIssues[0].recoveredBy, [2]);
  assert.equal(restoreWordIssues(merged.wordIssues, merged.words, 3590)[0].status, 'recovered');
});

test('interior bad words are quarantined individually while good words and later batches continue', async () => {
  const {chunkClock, analyseChunkWords} = await clockModule;
  const result = analyseChunkWords([word('正常', 3, 4), word('逆序', 5, 4), word('缺時間', null, 7),
    word('超界', 100, 350), word('後續正常', 101, 102)], chunkClock(3590, 300, 600), 304);
  assert.deepEqual(result.words.map(item => item.word), ['正常', '後續正常']);
  assert.equal(result.words[1].start, 399); assert.equal(result.words[1].end, 400);
  assert.equal(result.wordIssues.length, 3); assert.ok(result.wordIssues.every(issue => issue.zone === 'core'));
  const merged = mergeChunkWords([chunk(1, result.words, result.wordIssues), chunk(2, [word('更後面', 650, 651)])], 3590);
  assert.equal(merged.words.find(item => item.word === '更後面').start, 650);
  assert.ok(merged.wordIssues.every(issue => issue.status === 'review'));
  assert.throws(() => analyseChunkWords([], chunkClock(3590, 300, 600), 300), /回報長度/);
});

test('both overlap transcripts remain available when their midpoint ownership estimates disagree', () => {
  const merged = mergeChunkWords([chunk(0, [word('交界台詞', 299.9, 300.2)]),
    chunk(1, [word('交界台詞', 299.8, 300.1), word('後面的台詞', 302, 303)])], 600);
  assert.equal(merged.words.filter(item => item.word === '交界台詞').length, 1);
  assert.equal(merged.words[0].timingUncertain, true);
  assert.equal(merged.words[1].start, 302);
});

test('overlap matching preserves repeated speech and uses a complete neighbouring word without extending time', () => {
  const repeated = [word('啊', 299.1, 299.3), word('啊', 299.5, 299.7)];
  const merged = mergeChunkWords([chunk(0, repeated), chunk(1, [word('啊', 299.11, 299.31), word('啊', 299.51, 299.71),
    word('完整', 300.2, 301)])], 600);
  assert.equal(merged.words.filter(item => item.word === '啊').length, 2);
  assert.equal(merged.words.find(item => item.word === '完整').start, 300.2);
  const fallback = mergeChunkWords([chunk(0, [word('交界', 300.2, 301)]), chunk(1)], 600);
  assert.equal(fallback.words.length, 1); assert.equal(fallback.words[0].start, 300.2);
  assert.equal(fallback.words[0].end, 301); assert.equal(fallback.words[0].timingUncertain, true);
});

test('unresolved words require local review and preserve manual, stale and distant cues', () => {
  const issue = {wordIndex: 604, word: '缺少的詞', start: 303.705, end: 305.145, zone: 'next', reason: '超出片段'};
  const merged = mergeChunkWords([chunk(1, [], [issue]), chunk(2, [word('別的詞', 601.7, 603)])], 900);
  assert.equal(merged.wordIssues[0].status, 'review');
  const original = [{lineId: 'near', start: 601.7, end: 603, status: 'auto'},
    {lineId: 'manual', start: 601.7, end: 603, status: 'manual'},
    {lineId: 'stale', start: 601.7, end: 603, status: 'stale'},
    {lineId: 'far', start: 700, end: 701, status: 'auto'}];
  const reviewed = reviewWordIssues(original, merged.wordIssues);
  assert.equal(reviewed[0].status, 'review'); assert.match(reviewed[0].reviewReason, /尚未補回/);
  assert.deepEqual(reviewed.slice(1), original.slice(1));
  assert.equal(restoreWordIssues(merged.wordIssues, merged.words, 900)[0].status, 'review');
  assert.equal(reviewWordIssues([{start: 603.7, end: 605, status: 'auto'}], merged.wordIssues,
    {scale: 1, offset: 2})[0].status, 'review');
});

test('an unrelated repeated word later in the neighbour does not resolve an earlier issue', () => {
  const issue = {wordIndex: 0, word: '我', start: 303.705, end: 305.145, zone: 'next', reason: '超出片段'};
  const merged = mergeChunkWords([chunk(1, [], [issue]), chunk(2, [word('我', 603.5, 603.7)])], 900);
  assert.equal(merged.wordIssues[0].status, 'review');
  assert.throws(() => wordIssuesFor([{...issue, wordIndex: -1}]), /格式/);
  assert.throws(() => wordIssuesFor([{...issue, start: '303'}]), /格式/);
  assert.throws(() => restoreWordIssues([{...issue, chunkIndex: 99}], [], 900), /批次/);
});
