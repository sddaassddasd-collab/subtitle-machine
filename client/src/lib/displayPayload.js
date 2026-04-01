const normalizeInt = (rawValue, fallback, min = null, max = null) => {
  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.round(parsed)
  if (Number.isFinite(min) && rounded < min) return min
  if (Number.isFinite(max) && rounded > max) return max
  return rounded
}

export const DEFAULT_PROJECTOR_LAYOUT = Object.freeze({
  fontSizePercent: 100,
  offsetX: 0,
  offsetY: 24,
})

export const PROJECTOR_DISPLAY_MODES = Object.freeze({
  SCRIPT: 'script',
  TRANSCRIPTION: 'transcription',
})

export const normalizeProjectorLayout = (rawLayout) => {
  const source =
    rawLayout && typeof rawLayout === 'object'
      ? rawLayout
      : DEFAULT_PROJECTOR_LAYOUT

  return {
    fontSizePercent: normalizeInt(
      source.fontSizePercent,
      DEFAULT_PROJECTOR_LAYOUT.fontSizePercent,
    ),
    offsetX: normalizeInt(source.offsetX, DEFAULT_PROJECTOR_LAYOUT.offsetX),
    offsetY: normalizeInt(source.offsetY, DEFAULT_PROJECTOR_LAYOUT.offsetY),
  }
}

export const areProjectorLayoutsEqual = (leftLayout, rightLayout) => {
  const left = normalizeProjectorLayout(leftLayout)
  const right = normalizeProjectorLayout(rightLayout)
  return (
    left.fontSizePercent === right.fontSizePercent &&
    left.offsetX === right.offsetX &&
    left.offsetY === right.offsetY
  )
}

export const normalizeProjectorDisplayMode = (rawMode) =>
  rawMode === PROJECTOR_DISPLAY_MODES.TRANSCRIPTION
    ? PROJECTOR_DISPLAY_MODES.TRANSCRIPTION
    : PROJECTOR_DISPLAY_MODES.SCRIPT

export const normalizeProjectorRevision = (rawRevision) =>
  normalizeInt(rawRevision, 0, 0, Number.MAX_SAFE_INTEGER)

export const normalizeDisplayPayload = (payload) => {
  const enabled =
    typeof payload?.displayEnabled === 'boolean'
      ? payload.displayEnabled
      : true
  const roleColorEnabled = payload?.roleColorEnabled !== false
  const defaultLanguageId =
    typeof payload?.defaultLanguageId === 'string' &&
    payload.defaultLanguageId.trim().length > 0
      ? payload.defaultLanguageId.trim()
      : 'primary'

  const lineCandidate = payload?.line
  const nextLine =
    lineCandidate && typeof lineCandidate === 'object'
      ? {
          text: typeof lineCandidate.text === 'string' ? lineCandidate.text : '',
          type:
            lineCandidate.type === 'direction' ? 'direction' : 'dialogue',
          role:
            typeof lineCandidate.role === 'string' && lineCandidate.role.trim()
              ? lineCandidate.role.trim()
              : null,
          translations:
            lineCandidate.translations && typeof lineCandidate.translations === 'object'
              ? lineCandidate.translations
              : {},
        }
      : null

  const transcription = payload?.transcription || {}
  const transcriptionIsFinal = transcription.isFinal !== false
  const source =
    typeof payload?.source === 'string' ? payload.source : 'script'
  const liveEntries = Array.isArray(payload?.liveEntries)
    ? payload.liveEntries
        .map((entry) => ({
          text: typeof entry?.text === 'string' ? entry.text.trim() : '',
          speakerId:
            Number.isInteger(entry?.speakerId) && entry.speakerId > 0
              ? entry.speakerId
              : null,
          isFinal: entry?.isFinal !== false,
        }))
        .filter((entry) => entry.text)
    : []
  const liveLines = Array.isArray(payload?.liveLines)
    ? payload.liveLines
        .filter((line) => typeof line === 'string')
        .map((line) => line.trim())
        .filter(Boolean)
    : []
  const musicActive = payload?.musicActive === true
  const musicText =
    typeof payload?.musicText === 'string' && payload.musicText.trim().length > 0
      ? payload.musicText.trim()
      : '此處有音樂'

  return {
    enabled,
    line: nextLine,
    liveEntries,
    liveLines,
    musicActive,
    musicText,
    source,
    languages: Array.isArray(payload?.languages) ? payload.languages : [],
    defaultLanguageId,
    transcriptionIsFinal,
    layout: normalizeProjectorLayout(payload?.layout),
    displayMode: normalizeProjectorDisplayMode(payload?.displayMode),
    revision: normalizeProjectorRevision(payload?.revision),
    roleColorEnabled,
  }
}

export const resolveAvailableLanguageId = (languages, preferredLanguageId) => {
  const list = Array.isArray(languages) ? languages : []
  if (
    typeof preferredLanguageId === 'string' &&
    preferredLanguageId.trim().length > 0 &&
    list.some((language) => language?.id === preferredLanguageId.trim())
  ) {
    return preferredLanguageId.trim()
  }
  const fallback = list.find(
    (language) => typeof language?.id === 'string' && language.id.trim().length > 0,
  )
  return fallback?.id || 'primary'
}

export const resolveLineText = (line, languageId) => {
  if (!line) return ''
  if (languageId === 'primary') {
    return line.text || ''
  }
  if (
    languageId &&
    line.translations &&
    typeof line.translations[languageId] === 'string'
  ) {
    return line.translations[languageId]
  }
  return ''
}

export const roleToColor = (role) => {
  if (!role) return ''
  let hash = 0
  for (let index = 0; index < role.length; index += 1) {
    hash = (hash * 31 + role.charCodeAt(index)) % 360
  }
  return `hsl(${hash}deg 90% 76%)`
}
