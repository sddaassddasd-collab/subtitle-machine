// One hint per language from the Nova-3 multilingual language list.
const DEEPGRAM_LANGUAGE_HINTS = Object.freeze([
  'zh', 'zh-HK', 'en', 'fr', 'ja', 'ko', 'af', 'ar', 'be', 'bn', 'bs', 'bg',
  'ca', 'hr', 'cs', 'da', 'nl', 'et', 'fi', 'nl-BE', 'gl', 'de', 'el', 'gu',
  'he', 'hi', 'hu', 'id', 'it', 'kn', 'lv', 'lt', 'mk', 'ms', 'mr', 'no',
  'fa', 'pl', 'pt', 'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'sv', 'tl', 'ta',
  'te', 'th', 'tr', 'uk', 'vi', 'xh', 'zu',
]);
const supportedHints = new Set(DEEPGRAM_LANGUAGE_HINTS);

function normalizeMixedRecognition(settings) {
  const languages = [...new Set(
    Array.isArray(settings?.languages)
      ? settings.languages.filter(language => supportedHints.has(language))
      : [],
  )];
  return { enabled: settings?.enabled === true && languages.length >= 2, languages };
}

module.exports = { DEEPGRAM_LANGUAGE_HINTS, normalizeMixedRecognition };
