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
  widthPercent: 88,
  offsetX: 0,
  offsetY: 24,
})

export const PROJECTOR_DISPLAY_MODES = Object.freeze({
  SCRIPT: 'script',
  TRANSCRIPTION: 'transcription',
})

export const PROJECTOR_LANGUAGE_MODES = Object.freeze({
  SINGLE: 'single',
  BILINGUAL: 'bilingual',
  ALL: 'all',
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
    widthPercent: normalizeInt(
      source.widthPercent,
      DEFAULT_PROJECTOR_LAYOUT.widthPercent,
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
    left.widthPercent === right.widthPercent &&
    left.offsetX === right.offsetX &&
    left.offsetY === right.offsetY
  )
}

export const normalizeProjectorDisplayMode = (rawMode) =>
  rawMode === PROJECTOR_DISPLAY_MODES.TRANSCRIPTION
    ? PROJECTOR_DISPLAY_MODES.TRANSCRIPTION
    : PROJECTOR_DISPLAY_MODES.SCRIPT

export const normalizeProjectorLanguageMode = (rawMode) => {
  if (rawMode === PROJECTOR_LANGUAGE_MODES.BILINGUAL) {
    return PROJECTOR_LANGUAGE_MODES.BILINGUAL
  }
  if (rawMode === PROJECTOR_LANGUAGE_MODES.ALL) {
    return PROJECTOR_LANGUAGE_MODES.ALL
  }
  return PROJECTOR_LANGUAGE_MODES.SINGLE
}

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
  const normalizeLine = (line) =>
    line && typeof line === 'object'
      ? {
          id: typeof line.id === 'string' && line.id.trim() ? line.id.trim() : '',
          text: typeof line.text === 'string' ? line.text : '',
          type: line.type === 'direction' ? 'direction' : 'dialogue',
          music: line.music === true,
          musicCueId:
            line.music === true &&
            typeof line.musicCueId === 'string' &&
            line.musicCueId.trim()
              ? line.musicCueId.trim()
              : null,
          musicText:
            line.music === true &&
            typeof line.musicText === 'string' &&
            line.musicText.trim()
              ? line.musicText.trim()
              : '',
          role:
            typeof line.role === 'string' && line.role.trim()
              ? line.role.trim()
              : null,
          translations:
            line.translations && typeof line.translations === 'object'
              ? line.translations
              : {},
        }
      : null
  const nextLine =
    lineCandidate && typeof lineCandidate === 'object'
      ? normalizeLine(lineCandidate)
      : null
  const lines = Array.isArray(payload?.lines)
    ? payload.lines.map((line) => normalizeLine(line)).filter(Boolean)
    : []
  const currentIndex = normalizeInt(
    payload?.currentIndex,
    0,
    0,
    Array.isArray(payload?.lines)
      ? Math.max(lines.length - 1, 0)
      : Number.MAX_SAFE_INTEGER,
  )

  const transcription = payload?.transcription || {}
  const liveTranslationLanguages = Array.isArray(
    transcription.translationLanguages,
  )
    ? transcription.translationLanguages
    : []
  const allowedLiveTranslationLanguageCodes = Array.isArray(
    transcription.allowedTranslationLanguageCodes,
  )
    ? new Set(transcription.allowedTranslationLanguageCodes)
    : new Set(liveTranslationLanguages.map((language) => language?.code))
  const transcriptionIsFinal = transcription.isFinal !== false
  const source =
    typeof payload?.source === 'string' ? payload.source : 'script'
  const liveEntries = Array.isArray(payload?.liveEntries)
    ? payload.liveEntries
        .map((entry) => ({
          id: typeof entry?.id === 'string' ? entry.id : '',
          text: typeof entry?.text === 'string' ? entry.text.trim() : '',
          translations:
            entry?.translations && typeof entry.translations === 'object'
              ? entry.translations
              : {},
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
    lines,
    currentIndex,
    liveEntries,
    liveLines,
    musicActive,
    musicText,
    source,
    languages: Array.isArray(payload?.languages) ? payload.languages : [],
    defaultLanguageId,
    transcriptionIsFinal,
    liveTranslationLanguages: liveTranslationLanguages.filter((language) =>
      allowedLiveTranslationLanguageCodes.has(language?.code),
    ),
    liveTranslationStatus:
      transcription.translationStatus &&
      typeof transcription.translationStatus === 'object'
        ? transcription.translationStatus
        : {},
    transcriptionLanguage:
      typeof transcription.language === 'string' && transcription.language
        ? transcription.language
        : 'zh-TW',
    transcriptionSourceLanguages: Array.isArray(transcription.sourceLanguages)
      ? transcription.sourceLanguages
      : [],
    layout: normalizeProjectorLayout(payload?.layout),
    displayMode: normalizeProjectorDisplayMode(payload?.displayMode),
    languageMode: normalizeProjectorLanguageMode(payload?.languageMode),
    revision: normalizeProjectorRevision(payload?.revision),
    viewerRevision: normalizeInt(
      payload?.viewerRevision,
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    roleColorEnabled,
  }
}

export const normalizeLiveTranslationPatch = (payload) => {
  const liveEntries = Array.isArray(payload?.liveEntries)
    ? payload.liveEntries
        .map((entry) => ({
          id: typeof entry?.id === 'string' ? entry.id : '',
          text: typeof entry?.text === 'string' ? entry.text.trim() : '',
          translations:
            entry?.translations && typeof entry.translations === 'object'
              ? entry.translations
              : {},
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
    : liveEntries.map((entry) => entry.text)

  return {
    streamId: typeof payload?.streamId === 'string' ? payload.streamId : '',
    revision: normalizeInt(payload?.revision, 0, 0, Number.MAX_SAFE_INTEGER),
    languageCode:
      typeof payload?.languageCode === 'string' ? payload.languageCode : '',
    liveEntries,
    liveLines,
    transcriptionIsFinal: payload?.transcriptionIsFinal !== false,
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

export const resolveLanguageDisplayList = (
  languages,
  preferredLanguageId,
  languageMode = PROJECTOR_LANGUAGE_MODES.SINGLE,
) => {
  const list = Array.isArray(languages) ? languages : []
  if (!list.length) return []
  const mode = normalizeProjectorLanguageMode(languageMode)
  const primaryLanguage = list[0]
  const selectedLanguageId = resolveAvailableLanguageId(list, preferredLanguageId)
  const selectedLanguage =
    list.find((language) => language.id === selectedLanguageId) || primaryLanguage

  if (mode === PROJECTOR_LANGUAGE_MODES.ALL) {
    return list
  }

  if (mode === PROJECTOR_LANGUAGE_MODES.BILINGUAL) {
    const pair = [primaryLanguage]
    if (selectedLanguage && selectedLanguage.id !== primaryLanguage.id) {
      pair.push(selectedLanguage)
    } else {
      const firstExtraLanguage = list.find(
        (language) => language.id !== primaryLanguage.id,
      )
      if (firstExtraLanguage) pair.push(firstExtraLanguage)
    }
    return pair
  }

  return selectedLanguage ? [selectedLanguage] : [primaryLanguage]
}

export const roleToColor = (role) => {
  if (!role) return ''
  let hash = 0
  for (let index = 0; index < role.length; index += 1) {
    hash = (hash * 31 + role.charCodeAt(index)) % 360
  }
  return `hsl(${hash}deg 90% 76%)`
}
