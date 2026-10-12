const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const { reviewUnits, buildReviewBlocks, chunkReviewBlocks, validateReviewedBlock } = require('../src/script-segmentation-review');

// Exercise the actual parser, OpenAI request wiring and import routes without
// startup, reading the operator's data, writing storage or making API calls.
function fixture({ reviewer = blocks => blocks.map(block => ({
  blockId: block.blockId, segments: block.initialSegments,
})), annotator } = {}) {
  const requests = [], warnings = [];
  class FakeOpenAI {
    constructor() {
      this.responses = { create: async request => {
        requests.push(request);
        const prompt = request.input[1].content;
        const reviewMarker = '輸入 blocks：\n';
        if (prompt.includes(reviewMarker)) {
          const result = await reviewer(JSON.parse(prompt.slice(prompt.indexOf(reviewMarker) + reviewMarker.length)));
          return { output_text: typeof result === 'string' ? result : JSON.stringify(result) };
        }
        const marker = '輸入 units：\n';
        const units = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
        return { output_text: JSON.stringify(units.map(unit => annotator ? annotator(unit) : ({
          unitId: unit.id,
          type: /^[（(【\[]/u.test(unit.text) ? 'direction' : 'dialogue',
          role: (unit.text.match(/^([^：:]{1,12})[：:]/u) || [])[1] || null,
          mergeWithPrevious: false,
        }))) };
      } };
    }
  }
  const filename = require.resolve('../src/server');
  const source = fs.readFileSync(filename, 'utf8');
  assert.match(source, /startServer\(\);\s*$/);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = id => id === 'openai' ? { OpenAI: FakeOpenAI } : originalRequire(id);
  loaded._compile(source.replace(/startServer\(\);\s*$/, `
    persistSession = () => {};
    broadcastControlState = () => {};
    broadcastViewerState = () => {};
    module.exports = {
      parseScriptWithOpenAI, chunkDialogueText, measureSubtitleTextWidth, normalizeScriptLines,
      prepareImportedScriptLines, resolveScriptSegmentationProfile, joinAnnotatedUnitText,
      async route(languageCode, scriptText, secondary) {
        const owner = { id: 'script-review-owner', role: USER_ROLES.OPERATOR };
        users.set(owner.id, owner);
        const session = createSessionRecord(owner.id);
        session.languages[0].code = languageCode;
        if (secondary) session.languages.push({ id: 'english', code: languageCode, name: 'English' });
        sessions.set(session.id, session);
        const routePath = secondary
          ? '/api/session/:sessionId/cells/:cellId/languages/:languageId/parse'
          : '/api/session/:sessionId/script/parse';
        const route = app.router.stack.find(layer => layer.route?.path === routePath).route;
        const req = { authUser: owner, params: { sessionId: session.id, cellId: session.selectedCellId, languageId: 'english' },
          body: { apiKey: 'test-placeholder', cellId: session.selectedCellId, scriptText, scriptParseModel: 'gpt-4o-mini' } };
        const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
        for (const layer of route.stack) {
          let proceed = false;
          await layer.handle(req, res, () => { proceed = true; });
          if (!proceed) break;
        }
        return { status: res.code, body: res.body, session,
          stored: serializeSessionForStorage(session), viewer: () => getViewerPayload(session) };
      },
    };
  `), filename);
  const helpers = loaded.exports;
  return { ...helpers, requests, warnings,
    parse: (text, languageCode = 'zh-TW', model = 'gpt-4o-mini') => helpers.parseScriptWithOpenAI(text, 'test-placeholder', {
      languageCode, model, onWarning: warning => warnings.push(warning),
    }),
  };
}

const baseline = blocks => blocks.map(block => ({ blockId: block.blockId, segments: block.initialSegments }));
const whole = block => ({ blockId: block.blockId, segments: [{ startUnit: 1, endUnit: block.units.length }] });
const wordsOnly = text => text.replace(/\s/gu, '');

test('program candidates pack clauses rather than making every comma a short cue', () => {
  const f = fixture();
  assert.deepEqual(f.chunkDialogueText('今天的天氣很好，我們先去公園走走，晚一點再回來吃飯。'), [
    '今天的天氣很好，我們先去公園走走，', '晚一點再回來吃飯。',
  ]);
});

test('AI review merges initial short cues and may retain complete thoughts above the soft target', async () => {
  let input;
  const f = fixture({ reviewer: blocks => { input = blocks; return blocks.map(whole); } });
  const lines = await f.parse('甲：今天的天氣很好，\n我們先去公園走走吧。\n然後回家。');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, '今天的天氣很好，我們先去公園走走吧。然後回家。');
  assert.ok(f.measureSubtitleTextWidth(lines[0].text) > 20);
  assert.ok(f.measureSubtitleTextWidth(lines[0].text) <= 24);
  assert.equal(lines[0].role, '甲');
  assert.equal(input[0].initialSegments.length, 3);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.warnings, []);
});

test('AI can split one candidate at a meaningful clause boundary and preserve every original symbol', async () => {
  const f = fixture({ reviewer: blocks => blocks.map(block => ({ blockId: block.blockId,
    segments: [{ startUnit: 1, endUnit: 1 }, { startUnit: 2, endUnit: block.units.length }],
  })) });
  const lines = await f.parse('甲：我回來了！你怎麼還沒睡？');
  assert.deepEqual(lines.map(line => line.text), ['我回來了！', '你怎麼還沒睡？']);
  assert.equal(lines.map(line => line.text).join(''), '我回來了！你怎麼還沒睡？');
});

test('AI can split inside a longer unpunctuated clause without breaking Unicode or English words', async () => {
  const f = fixture({ reviewer: blocks => blocks.map(block => {
    const cut = block.units.findIndex(unit => unit.text === '你');
    assert.ok(cut > 0);
    return { blockId: block.blockId, segments: [{ startUnit: 1, endUnit: cut }, { startUnit: cut + 1, endUnit: block.units.length }] };
  }) });
  const text = '我一直以為你不會再回來';
  assert.deepEqual((await f.parse(text)).map(line => line.text), ['我一直以為', '你不會再回來']);
  const profile = f.resolveScriptSegmentationProfile('zh-TW');
  const mixed = '我們走向Broadway然後一起望向𠮷野家😀';
  const units = reviewUnits(mixed, profile, f.measureSubtitleTextWidth);
  assert.equal(units.join(''), mixed);
  assert.ok(units.includes('Broadway'));
  assert.ok(units.includes('𠮷'));
  assert.ok(units.includes('😀'));
});

test('different actors and stage directions bound review blocks; contiguous directions merge with line breaks', async () => {
  let blocks;
  const f = fixture({ reviewer: input => { blocks = input; return input.map(whole); } });
  const lines = await f.parse('甲：我回來了。\n乙：你怎麼還沒睡？\n（燈光漸暗）\n（演員退場）\n甲：明天見。\n（燈亮）');
  assert.deepEqual(lines.map(line => [line.type, line.role, line.text]), [
    ['dialogue', '甲', '我回來了。'], ['dialogue', '乙', '你怎麼還沒睡？'],
    ['direction', null, '（燈光漸暗）\n（演員退場）'], ['dialogue', '甲', '明天見。'],
    ['direction', null, '（燈亮）'],
  ]);
  assert.deepEqual(blocks.map(block => block.role), ['甲', '乙', '甲']);
  assert.equal(lines[2].translations.primary, lines[2].text);
  assert.equal(f.normalizeScriptLines(lines)[2].text, lines[2].text);
});

test('adjacent inline directions merge, and long directions do not inherit dialogue length limits', async () => {
  const f = fixture();
  const direction = `（燈光漸暗，演員退場，${'舞台保持沉默，'.repeat(8)}）`;
  const lines = await f.parse(`甲：我回來了。（燈光漸暗）（演員退場）${direction}甲：再見。`);
  assert.equal(lines.length, 3);
  assert.equal(lines[1].text, `（燈光漸暗）\n（演員退場）\n${direction}`);
  assert.ok(f.measureSubtitleTextWidth(lines[1].text) > 24);
  assert.equal(lines[2].text, '再見。');
});

test('direction merging spans annotation batches and all-direction scripts need no boundary review', async () => {
  const f = fixture();
  const directions = Array.from({ length: 94 }, (_, index) => `（燈光漸暗第${index}次）`);
  const lines = await f.parse(directions.join('\n'));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, directions.join('\n'));
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.warnings, []);
});

test('English review keeps words, spaces, punctuation and one actor across input paragraphs', async () => {
  const f = fixture({ reviewer: blocks => blocks.map(whole) });
  const lines = await f.parse('Alice: Dr. Smith is here.\nWe should leave now.', 'en');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'Dr. Smith is here. We should leave now.');
  assert.equal(lines[0].role, 'Alice');
  assert.ok(f.requests[1].input[1].content.includes('"hardWidth":72'));
  assert.equal(f.requests[0].model, f.requests[1].model);
});

test('Latin, French and German review can exceed the target without the final guard undoing valid cuts', async () => {
  const text = 'We will remember every moment of this beautiful evening and carry it with us when we finally return home together to meet our friends.';
  for (const language of ['en', 'fr', 'de']) {
    const f = fixture({ reviewer: blocks => blocks.map(whole) });
    const lines = await f.parse(text, language);
    assert.equal(lines.length, 1, language);
    assert.equal(lines[0].text, text);
    assert.ok(f.measureSubtitleTextWidth(text) > 60);
    assert.ok(f.measureSubtitleTextWidth(text) <= 72);
    assert.deepEqual(f.warnings, []);
  }
});

test('gpt-5 reviewer uses the selected model and reasoning options', async () => {
  const f = fixture();
  await f.parse('我回來了。', 'zh-TW', 'gpt-5.5');
  for (const request of f.requests) {
    assert.equal(request.model, 'gpt-5.5');
    assert.deepEqual(request.reasoning, { effort: 'low' });
    assert.equal(request.temperature, undefined);
  }
});

test('invalid, missing, duplicated, reordered, overlong and rewritten reviews retain program cues with a warning', async t => {
  const invalid = {
    omission: blocks => [{ blockId: blocks[0].blockId, segments: [{ startUnit: 2, endUnit: blocks[0].units.length }] }],
    overlap: blocks => [{ blockId: blocks[0].blockId, segments: [{ startUnit: 1, endUnit: 1 }, { startUnit: 1, endUnit: blocks[0].units.length }] }],
    reorder: blocks => [{ blockId: blocks[0].blockId, segments: [{ startUnit: 2, endUnit: 2 }, { startUnit: 1, endUnit: 1 }] }],
    overlong: blocks => blocks.map(whole),
    missing: () => [],
    duplicate: blocks => [...baseline(blocks), ...baseline(blocks)],
    foreign: blocks => [...baseline(blocks), { blockId: 999, segments: [] }],
    rewrite: () => [{ text: 'AI 改寫的文字' }],
    truncated: () => '[{"blockId":1,"segments":[{"startUnit":1,"endUnit":1}]',
    failedService: () => { throw new Error('simulated provider outage'); },
  };
  const text = '甲：今天的天氣很好，我們先去公園走走，晚一點再回來吃飯。';
  for (const [name, reviewer] of Object.entries(invalid)) await t.test(name, async () => {
    const f = fixture({ reviewer });
    const lines = await f.parse(text);
    assert.deepEqual(lines.map(line => line.text), ['今天的天氣很好，我們先去公園走走，', '晚一點再回來吃飯。']);
    assert.equal(lines.map(line => line.text).join(''), text.slice(2));
    assert.match(f.warnings.join(''), /保留程式切點/);
  });
});

test('a bad block does not discard a valid review of another actor', async () => {
  const f = fixture({ reviewer: blocks => [whole(blocks[0])] });
  const lines = await f.parse('甲：我回來了。\n你好嗎？\n乙：今天的天氣很好，我們先去公園走走，晚一點再回來吃飯。');
  assert.equal(lines[0].text, '我回來了。你好嗎？');
  assert.deepEqual(lines.slice(1).map(line => line.text), ['今天的天氣很好，我們先去公園走走，', '晚一點再回來吃飯。']);
  assert.match(f.warnings.join(''), /有 1 組/);
});

test('quoted source survives review, normalization and route persistence; directions remain hidden to viewers', async () => {
  const f = fixture();
  const result = await f.route('zh-TW', '甲：我說：「你怎麼還沒睡？」\n（燈光漸暗）\n（演員退場）');
  assert.equal(result.status, 200);
  assert.equal(result.body.parsedLineCount, 2);
  assert.equal(result.body.lines[0].text, '我說：「你怎麼還沒睡？」');
  assert.equal(result.stored.sharedLines[1].text, '（燈光漸暗）\n（演員退場）');
  assert.equal(result.stored.sharedLines[1].translations.primary, result.stored.sharedLines[1].text);
  result.session.currentIndex = 1;
  assert.equal(result.viewer().text, '');
  assert.equal(result.viewer().line.text, '（燈光漸暗）\n（演員退場）');
  assert.equal(result.body.lines[1].type, 'direction');
  assert.ok(result.session.history.past.length > 0);
});

test('primary and secondary imports expose review warnings and merge directions in the imported column', async () => {
  for (const secondary of [false, true]) {
    const f = fixture({ reviewer: () => { throw new Error('simulated outage'); } });
    const result = await f.route('en', 'Alice: I am home.\n(The lights dim.)\n(The actors leave.)', secondary);
    assert.equal(result.status, 200);
    assert.match(result.body.warning, /保留程式切點/);
    assert.equal(result.body.parsedLineCount, 2);
    const key = secondary ? 'english' : 'primary';
    assert.equal(result.body.lines[1].translations[key], '(The lights dim.)\n(The actors leave.)');
  }
});

test('large scripts retain the entire ordered source across review batches and bounded stage context', async () => {
  const f = fixture();
  const raw = Array.from({ length: 220 }, (_, i) => `甲：我們今晚要一起去看第${i}場演出。`).join('\n');
  const lines = await f.parse(raw);
  assert.equal(wordsOnly(lines.map(line => line.text).join('')), wordsOnly(raw.replaceAll('甲：', '')));
  assert.equal(lines.length, 220);
  const reviews = f.requests.filter(request => request.input[1].content.includes('輸入 blocks：'));
  assert.ok(reviews.length > 1);
  assert.deepEqual(f.warnings, []);
  const profile = f.resolveScriptSegmentationProfile('zh-TW');
  const blocks = buildReviewBlocks([
    { type: 'direction', text: '（燈光漸暗）'.repeat(1000) },
    { type: 'dialogue', text: '我回來了。' },
  ], { profile, measureText: f.measureSubtitleTextWidth, joinText: f.joinAnnotatedUnitText });
  assert.equal(chunkReviewBlocks(blocks).length, 1);
  assert.throws(() => validateReviewedBlock(blocks[0], { ...whole(blocks[0]), segments: [{ startUnit: 1, endUnit: 0 }] }, f.measureSubtitleTextWidth));
});
