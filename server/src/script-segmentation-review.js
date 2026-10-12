// Review only boundaries. The model never supplies subtitle text, roles or types.
// Every accepted cue is reconstructed from consecutive, immutable source units.
const MAX_BLOCK_UNITS = 180;
const MAX_BATCH_UNITS = 240;
const MAX_BATCH_CHARS = 3600;
const CLAUSE_END = /[，,、；;。．.!！？?：:…]/u;
const CLOSING_MARK = /[，,、；;。．.!！？?：:…」』”"’')）】\]]/u;

function reviewUnits(text, profile, measureText) {
  if (profile.family === 'latin') {
    return text.match(/\S+\s*|\s+/gu) || [text];
  }

  const clauses = [];
  const chars = Array.from(text);
  let current = '';
  for (let index = 0; index < chars.length; index += 1) {
    current += chars[index];
    if (!CLAUSE_END.test(chars[index])) continue;
    while (index + 1 < chars.length && CLOSING_MARK.test(chars[index + 1])) {
      current += chars[++index];
    }
    clauses.push(current);
    current = '';
  }
  if (current) clauses.push(current);
  // A long clause needs finer cut choices; never split a Unicode code point.
  return clauses.flatMap(clause => measureText(clause) > profile.maxLineWidthUnits / 2
    ? clause.match(/[\p{Script=Latin}\p{N}]+(?:['’\-][\p{Script=Latin}\p{N}]+)*\s*|[\s\S]/gu)
    : [clause]);
}

function buildReviewBlocks(lines, { profile, measureText, joinText }) {
  const blocks = [];
  let block = null;
  lines.forEach((line, index) => {
    if (line.type === 'direction') {
      block = null;
      return;
    }
    const units = reviewUnits(line.text, profile, measureText);
    const role = line.role || null;
    if (!block || block.role !== role || block.units.length + units.length > MAX_BLOCK_UNITS) {
      block = { blockId: blocks.length + 1, role, startIndex: index, endIndex: index,
        units: [], initialSegments: [], targetWidth: profile.maxLineWidthUnits,
        hardWidth: Math.ceil(profile.maxLineWidthUnits * 1.2) };
      blocks.push(block);
    }
    if (block.units.length) {
      const previous = block.units.map(unit => unit.text).join('');
      const joined = joinText(previous, line.text);
      const separator = joined.slice(previous.length, joined.length - line.text.length);
      block.units[block.units.length - 1].text += separator;
    }
    const startUnit = block.units.length + 1;
    units.forEach(text => block.units.push({ id: block.units.length + 1, text }));
    block.initialSegments.push({ startUnit, endUnit: block.units.length });
    block.endIndex = index;
  });
  return blocks;
}

function chunkReviewBlocks(blocks) {
  const batches = [];
  let batch = [], units = 0, chars = 0;
  for (const block of blocks) {
    const size = block.units.reduce((sum, unit) => sum + unit.text.length, 0);
    if (batch.length && (units + block.units.length > MAX_BATCH_UNITS || chars + size > MAX_BATCH_CHARS)) {
      batches.push(batch);
      batch = []; units = 0; chars = 0;
    }
    batch.push(block);
    units += block.units.length; chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function validateReviewedBlock(block, proposal, measureText) {
  if (proposal?.blockId !== block.blockId || !Array.isArray(proposal.segments) || !proposal.segments.length) {
    throw new Error('缺少完整分段建議');
  }
  const texts = [];
  let expectedStart = 1;
  for (const { startUnit, endUnit } of proposal.segments) {
    if (!Number.isInteger(startUnit) || !Number.isInteger(endUnit) || startUnit !== expectedStart ||
        endUnit < startUnit || endUnit > block.units.length) {
      throw new Error('分段有遺漏、重複或順序錯誤');
    }
    const text = block.units.slice(startUnit - 1, endUnit).map(unit => unit.text).join('').trim();
    if (!text || measureText(text) > block.hardWidth) throw new Error('字幕超過顯示上限');
    // Do not detach an opening or closing quote/bracket from its contents.
    if (/[「『“（【\[]$/u.test(text) || /^[」』”）】\]]/u.test(text)) {
      throw new Error('切點拆開引號或括號');
    }
    texts.push(text);
    expectedStart = endUnit + 1;
  }
  if (expectedStart !== block.units.length + 1) throw new Error('分段未涵蓋全部原文');
  return texts;
}

function mergeConsecutiveDirections(lines, createLine) {
  const result = [];
  for (const line of lines) {
    const previous = result[result.length - 1];
    if (line.type !== 'direction' || previous?.type !== 'direction') {
      result.push(line);
      continue;
    }
    const text = `${previous.text}\n${line.text}`;
    const translations = {};
    for (const key of new Set([...Object.keys(previous.translations || {}), ...Object.keys(line.translations || {})])) {
      translations[key] = [previous.translations?.[key], line.translations?.[key]].filter(Boolean).join('\n');
    }
    translations.primary = text;
    result[result.length - 1] = createLine({ ...previous, text, translations, role: null });
  }
  return result;
}

async function reviewScriptSegmentation(lines, { profile, measureText, joinText, createLine, requestReview, onWarning }) {
  const candidates = mergeConsecutiveDirections(lines, createLine);
  const blocks = buildReviewBlocks(candidates, { profile, measureText, joinText });
  const replacements = new Map();
  let fallbackCount = 0;
  for (const batch of chunkReviewBlocks(blocks)) {
    let proposals;
    try {
      proposals = await requestReview(batch.map(block => ({
        blockId: block.blockId, role: block.role, targetWidth: block.targetWidth, hardWidth: block.hardWidth,
        units: block.units, initialSegments: block.initialSegments,
        before: (candidates[block.startIndex - 1]?.text || '').slice(-240),
        after: (candidates[block.endIndex + 1]?.text || '').slice(0, 240),
      })));
      if (!Array.isArray(proposals) || proposals.some(proposal => !batch.some(block => block.blockId === proposal?.blockId))) {
        throw new Error('審核回應包含未知段落');
      }
    } catch {
      fallbackCount += batch.length;
      continue;
    }
    for (const block of batch) {
      try {
        const matching = proposals.filter(proposal => proposal?.blockId === block.blockId);
        if (matching.length !== 1) throw new Error('審核段落缺少或重複');
        const texts = validateReviewedBlock(block, matching[0], measureText);
        replacements.set(block.startIndex, { endIndex: block.endIndex, lines: texts.map(text => createLine({
          text, type: 'dialogue', role: block.role, translations: { primary: text },
        })) });
      } catch {
        fallbackCount += 1;
      }
    }
  }
  const result = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const replacement = replacements.get(index);
    if (replacement) {
      result.push(...replacement.lines);
      index = replacement.endIndex;
    } else {
      result.push(candidates[index]);
    }
  }
  if (fallbackCount) {
    onWarning?.(`有 ${fallbackCount} 組台詞未通過 AI 分段審核，已保留程式切點；請檢查解析結果。`);
  }
  return result;
}

module.exports = { reviewUnits, buildReviewBlocks, chunkReviewBlocks, validateReviewedBlock,
  mergeConsecutiveDirections, reviewScriptSegmentation };
