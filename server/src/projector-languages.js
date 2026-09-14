// Keep the old primary + selected pair when migrating a pre-selector session.
function resolveProjectorLanguages({ languages = [], defaultLanguageId, secondaryLanguageId, languageMode }) {
  const list = Array.isArray(languages) ? languages : [];
  const mode = languageMode === 'bilingual' || languageMode === 'all' ? 'bilingual' : 'single';
  const first = list[0]?.id || 'primary';
  let top = list.some(language => language.id === defaultLanguageId) ? defaultLanguageId : first;
  let bottom = secondaryLanguageId;
  if (secondaryLanguageId === undefined && mode === 'bilingual') {
    bottom = top !== first ? top : list.find(language => language.id !== first)?.id;
    top = first;
  }
  if (bottom === top || !list.some(language => language.id === bottom)) {
    bottom = list.find(language => language.id !== top)?.id || null;
  }
  return { defaultLanguageId: top, secondaryLanguageId: bottom, languageMode: mode };
}

module.exports = { resolveProjectorLanguages };
