export default function ProjectorLanguageSettings({ languages, mode, languageId, secondaryLanguageId, busy, onLanguagesChange, onModeChange }) {
  const bilingual = mode === 'bilingual'
  return (
    <>
      <label className="input-group" htmlFor="projector-default-language">
        <span>{bilingual ? '投影上排語言' : '投影端播放語言'}</span>
        <select id="projector-default-language" value={languageId} disabled={busy}
          onChange={event => {
            const top = event.target.value
            const bottom = secondaryLanguageId !== top ? secondaryLanguageId
              : languages.find(language => language.id !== top)?.id || null
            onLanguagesChange(top, bottom)
          }}>
          {languages.map(language => (
            <option key={language.id} value={language.id} disabled={bilingual && language.id === secondaryLanguageId}>
              {language.name}
            </option>
          ))}
        </select>
      </label>
      {bilingual && (
        <label className="input-group" htmlFor="projector-secondary-language">
          <span>投影下排語言</span>
          <select id="projector-secondary-language" value={secondaryLanguageId || ''}
            disabled={busy || languages.length < 2}
            onChange={event => onLanguagesChange(languageId, event.target.value)}>
            {languages.length < 2 && <option value="">尚無第二種語言</option>}
            {languages.map(language => (
              <option key={language.id} value={language.id} disabled={language.id === languageId}>
                {language.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {bilingual && secondaryLanguageId && (
        <div className="input-group">
          <span>排列順序</span>
          <button type="button" className="subtle-button" disabled={busy}
            onClick={() => onLanguagesChange(secondaryLanguageId, languageId)}>
            交換上下排
          </button>
        </div>
      )}
      <label className="input-group" htmlFor="projector-language-mode">
        <span>投影端模式</span>
        <select id="projector-language-mode" value={mode} disabled={busy} onChange={onModeChange}>
          <option value="single">單語</option>
          <option value="bilingual" disabled={languages.length < 2}>雙語並置</option>
        </select>
      </label>
    </>
  )
}
