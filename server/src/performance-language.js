const SOURCE_LANGUAGES = Object.freeze([
  {code: 'zh-TW', name: '繁體中文（台灣）', originalLabel: '原文（繁體中文）'},
  {code: 'en', name: 'English', originalLabel: 'Original (English)'},
  {code: 'ja', name: '日本語', originalLabel: '原文（日本語）'},
  {code: 'ko', name: '한국어', originalLabel: '원문(한국어)'},
  {code: 'es', name: 'Español', originalLabel: 'Original (Español)'},
  {code: 'fr', name: 'Français', originalLabel: 'Original (Français)'},
  {code: 'de', name: 'Deutsch', originalLabel: 'Original (Deutsch)'},
]);
const namePatterns = {
  'zh-TW': /中文|華語|國語|漢語|汉语|繁體|簡體|简体|chinese|mandarin/i,
  en: /英文|英語|english/i,
  ja: /日文|日語|日本語|japanese/i,
  ko: /韓文|韓語|한국어|korean/i,
  es: /西班牙|español|spanish/i,
  fr: /法文|法語|français|french/i,
  de: /德文|德語|deutsch|german/i,
};
const supportedLanguage = code => SOURCE_LANGUAGES.find(entry =>
  entry.code.toLowerCase() === String(code || '').trim().toLowerCase());
const normalizePerformanceLanguage = code => supportedLanguage(code)?.code || 'zh-TW';
const languageName = code => supportedLanguage(code)?.name || code;
const scriptFamily = code => String(code || '').trim().toLowerCase().split('-')[0];

function resolveFollowingLanguage(session, language = session.transcriptionLanguage) {
  const code = normalizePerformanceLanguage(language);
  const languages = session.languages?.length ? session.languages : [{id: 'primary', name: '第一語言', code: 'lang-1'}];
  const binding = session.followingLanguageIds?.[code];
  const family = scriptFamily(code);
  let selected;
  if (binding) selected = languages.find(entry => entry.id === binding);
  else {
    selected = languages.find(entry => scriptFamily(entry.code) === family) ||
      languages.find(entry => namePatterns[code].test(entry.name || ''));
    // Existing unnamed primary scripts were followed as Mandarin. Other
    // languages require a matching column or an explicit operator binding.
    if (!selected && code === 'zh-TW' &&
      /^lang-\d+$/.test(languages[0].code || '') && /^第一語言$/.test(languages[0].name || '')) selected = languages[0];
  }
  return {language: code, languageId: selected?.id || null, languageName: selected?.name || null,
    explicit: Boolean(binding)};
}

function selectedText(line, languageId) {
  if (line.type === 'direction') return String(line.text || '');
  if (!languageId) return '';
  return String(languageId === 'primary' ? line.text || '' : line.translations?.[languageId] || '');
}

function validPinnedId(session, id) {
  return (session.languages?.some(language => language.id === id) ||
    (!session.languages?.length && id === 'primary')) ? id : null;
}

// Preserve cue IDs/indices and display translations. Only matching text changes.
// Reuse the projected array even when session normalization recreates the source.
const projections = new WeakMap();
function getFollowingLines(session, language = session.transcriptionLanguage, lines = session.lines || [], pinnedId) {
  const code = normalizePerformanceLanguage(language);
  const languageId = pinnedId === undefined ? resolveFollowingLanguage(session, code).languageId : validPinnedId(session, pinnedId);
  const key = `${code}:${languageId}:${session.selectedCellId || ''}`;
  let cache = projections.get(session);
  if (!cache) { cache = new Map(); projections.set(session, cache); }
  const previous = cache.get(key);
  if (previous?.length === lines.length && lines.every((line, index) => {
    const old = previous[index];
    return old.id === line.id && old.type === line.type && old.music === line.music && old.role === line.role &&
      old.text === selectedText(line, languageId);
  })) return previous;
  const projected = lines.map(line => ({...line, text: selectedText(line, languageId)}));
  if (cache.size >= 16) cache.clear();
  cache.set(key, projected);
  return projected;
}

function describeFollowingScript(session, language = session.transcriptionLanguage, lines = session.lines || [], pinnedId) {
  const resolved = resolveFollowingLanguage(session, language);
  const languageId = pinnedId === undefined ? resolved.languageId : validPinnedId(session, pinnedId);
  const selected = session.languages?.find(entry => entry.id === languageId);
  const missingIndices = [];
  let dialogueCount = 0;
  lines.forEach((line, index) => {
    if (line.type === 'direction' || !(String(line.text || '').trim() ||
      Object.values(line.translations || {}).some(text => String(text || '').trim()))) return;
    dialogueCount++;
    if (!selectedText(line, languageId).trim()) missingIndices.push(index);
  });
  const name = languageName(resolved.language);
  const message = !languageId ? (pinnedId === undefined
    ? `找不到 ${name} 的劇本欄，請選擇「跟戲使用的劇本欄」。`
    : `此錄音尚未對應 ${name} 的劇本欄，請先設定演出語言與劇本欄，再重新自動切段。`)
    : missingIndices.length ? `${selected?.name || '所選劇本欄'}有 ${missingIndices.length} 格缺少台詞，請補齊；缺漏格不會拿其他語言代替。` : '';
  return {...resolved, languageId, languageName: selected?.name || resolved.languageName,
    dialogueCount, missingCount: missingIndices.length, missingIndices,
    available: Boolean(languageId) && dialogueCount > missingIndices.length, message};
}

function isRecordingCompatible(session, recording) {
  const code = normalizePerformanceLanguage(session.transcriptionLanguage);
  const selected = resolveFollowingLanguage(session, code);
  return session.captionMode !== 'live' && recording.language === code && Boolean(selected.languageId) &&
    recording.scriptLanguageId === selected.languageId;
}

module.exports = {SOURCE_LANGUAGES, supportedLanguage, normalizePerformanceLanguage, languageName,
  resolveFollowingLanguage, getFollowingLines, describeFollowingScript, isRecordingCompatible};
