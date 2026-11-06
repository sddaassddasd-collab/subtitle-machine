// Keep one physical caption area through source changes. A missing translation
// cannot borrow another language's text or pair with an older source caption.
export function captionFrame({scope, enabled, source, scriptRows = [], liveRows = [], entryId = '', color = ''}, previous) {
  if (!enabled || ['hidden', 'waiting', 'direction'].includes(source)) return {scope, key: '', source, rows: [], color: ''}
  const rows = source === 'transcription' ? liveRows : scriptRows
  if (rows.some(row => row.text?.trim())) return {scope, key: `${source}:${entryId}`, source, rows, color}
  if (source === 'transcription' && previous?.scope === scope) return previous
  return {scope, key: '', source, rows: [], color: ''}
}

export function latestCaptionRows(entries, languages) {
  const entry = entries.at(-1)
  if (!entry) return []
  return languages.map(({id, source, code}) => ({id,
    text: source ? entry.text || '' : entry.translations?.[code] || ''}))
}
