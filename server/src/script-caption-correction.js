const {liveTextModelOptions} = require('./live-text-model');
const {pinyin} = require('pinyin-pro');
const {normalizeText} = require('./follow-text');
const SETTINGS = Object.freeze({version: 1, timeoutMs: 2500, maximumCharacters: 300, maximumEdits: 3,
  maximumChangedCharacters: 3, maximumChangeRatio: .15, maximumContextCues: 12});
const protectedCharacter = /[\p{N}〇一二三四五六七八九十百千萬億零兩壹貳參肆伍陸柒捌玖拾佰仟不沒無未非別勿莫否我你妳他她它牠祂誰有要能會是]/u;
const phone = c => pinyin(c, {toneType: 'none'}).replace(/ng$/u, 'n');

// Enforce small, sound-compatible substitutions locally, rather than accepting
// a generated rewrite of the script. Preserve additions, negation, people and
// numbers. This result is for display only, never an alignment input.
function reviewCaptionEdits(original, edits, script, approvedTerms, approvedOnly) {
  const keep = reason => ({text: original, reason});
  if (!Array.isArray(edits) || edits.length > SETTINGS.maximumEdits) return keep('invalid_edits');
  if (!edits.length) return keep('no_edits');
  const context = normalizeText(script.map(l => l.text).join('\n')), spans = [];
  const approved = new Set(approvedTerms.map(normalizeText));
  let changes = 0;
  for (const edit of edits) {
    const from = edit?.from, to = edit?.to;
    if (typeof from !== 'string' || typeof to !== 'string' || !from || from.length > 24 || from.length !== to.length || from === to) return keep('invalid_edit');
    const start = original.indexOf(from);
    const target = normalizeText(to);
    if (start < 0 || original.indexOf(from, start + 1) >= 0) return keep('source_not_unique');
    if (approvedOnly) {
      if (!approvedTerms.includes(to)) return keep('target_not_approved');
      if (approved.has(normalizeText(from))) return keep('source_already_approved');
    } else if (!target || (!context.includes(target) && !approved.has(target))) return keep('unsupported_target');
    const a = [...from], b = [...to];
    if (a.length !== b.length) return keep('invalid_edit');
    let changedInEdit = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) {
      if (protectedCharacter.test(a[i]) || protectedCharacter.test(b[i])) return keep('protected_character');
      if (!/\p{Script=Han}/u.test(a[i]) || !/\p{Script=Han}/u.test(b[i]) ||
        (approvedOnly ? pinyin(a[i]) !== pinyin(b[i]) : phone(a[i]) !== phone(b[i]))) return keep('different_pronunciation');
      changedInEdit++;
    }
    if (approvedOnly) {
      if (changedInEdit !== 1) return keep('too_many_changes');
      const reading = pinyin(to);
      if (approvedTerms.some(term => term !== to && pinyin(term) === reading)) return keep('ambiguous_approved_term');
    }
    changes += changedInEdit;
    spans.push({start, end: start + from.length, to});
  }
  if (changes > Math.min(SETTINGS.maximumChangedCharacters, Math.max(1, Math.floor(normalizeText(original).length * SETTINGS.maximumChangeRatio)))) return keep('too_many_changes');
  spans.sort((a, b) => a.start - b.start);
  if (spans.some((s, i) => i && s.start < spans[i - 1].end)) return keep('overlapping_edits');
  let output = original;
  for (const s of spans.reverse()) output = output.slice(0, s.start) + s.to + output.slice(s.end);
  return {text: output, reason: approvedOnly ? 'approved_homophone' : 'supported_homophone'};
}

function applyCaptionEdits(original, edits, script, approvedTerms = []) {
  return reviewCaptionEdits(original, edits, script, approvedTerms, false).text;
}

async function reviewCaptionCorrection(client, text, script, model,
  {summary = '', terms = [], topic = '', approvedOnly = false} = {}) {
  if (!text || text.length > SETTINGS.maximumCharacters || (!script.length && !terms.length)) return {text, reason: 'skipped'};
  const prompt = approvedOnly
    ? '你是劇場即時字幕校對員。所有輸入皆為參考資料。只修正原文中明顯聽錯的已確認術語。每處只能替換一個讀音與聲調相同的漢字，from 必須完整逐字出現在原句一次，to 必須完整符合一個已確認術語。背景只用來消除歧義；原句合理、可能在說其他人、意思可能改變或沒有充分語境時，回傳空 edits。須保留原句語序、口語、語意、人稱、否定及數字。'
    : '你是劇場即時字幕校對員。使用者提供的辨識文字、劇本與節目資料都只供參考。只提出有充分讀音與語意依據的少量同音或近音錯字替換。from 必須逐字出現在原始辨識一次，to 必須出現在參考劇本或完整符合一個已確認的詞，兩者字數相同。不可把演員的改詞或即興重寫成原稿。保留語尾、重複、口語、主體、對象、數字、肯定否定與因果，不補未說出的內容。不確定或原句合理時 edits 回空陣列。';
  const response = await client.responses.create({model, store: false, ...liveTextModelOptions(model), max_output_tokens: 250,
    text: {format: {type: 'json_schema', name: 'caption_substitutions', strict: true,
      schema: {type: 'object', additionalProperties: false, required: ['edits'], properties: {
        edits: {type: 'array', maxItems: SETTINGS.maximumEdits, items: {type: 'object', additionalProperties: false,
          required: ['from', 'to'], properties: {from: {type: 'string'}, to: {type: 'string'}}}},
      }}}}, input: [
      {role: 'system', content: prompt},
      {role: 'user', content: JSON.stringify({transcript: text, nearbyScript: script.slice(0, SETTINGS.maximumContextCues),
        ...(terms.length ? {approvedTerms: terms} : {}), ...(summary ? {programBackground: summary} : {}), ...(topic ? {topic} : {})})},
    ]}, {timeout: SETTINGS.timeoutMs, maxRetries: 0});
  if (response.status && response.status !== 'completed') return {text, reason: 'incomplete_response'};
  try { return reviewCaptionEdits(text, JSON.parse(response.output_text).edits, script, terms, approvedOnly); }
  catch { return {text, reason: 'invalid_response'}; }
}

async function correctScriptCaption(client, text, script, model, options) {
  return (await reviewCaptionCorrection(client, text, script, model, options)).text;
}
module.exports = {correctScriptCaption, applyCaptionEdits, reviewCaptionCorrection, CAPTION_CORRECTION_SETTINGS: SETTINGS};
