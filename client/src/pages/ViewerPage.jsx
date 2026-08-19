import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  normalizeDisplayPayload,
  resolveAvailableLanguageId,
  resolveLanguageDisplayList,
  resolveLineText,
  roleToColor,
} from '../lib/displayPayload'

const VIEWER_FONT_STORAGE_KEY = 'subtitleMachineViewerFontPercent'
const VIEWER_LIVE_LANGUAGE_STORAGE_KEY = 'subtitleMachineViewerLiveLanguage'
const DEFAULT_VIEWER_FONT_PERCENT = 100
const MIN_VIEWER_FONT_PERCENT = 70
const MAX_VIEWER_FONT_PERCENT = 180
const VIEWER_FONT_STEP = 10
const PUBLIC_STATE_REFRESH_INTERVAL_MS = 15000
const PUBLIC_RECOVERY_RETRY_DELAY_MS = 1200
const ALL_LANGUAGES_OPTION_ID = '__all_languages__'

const getInitialViewerFontPercent = () => {
  if (typeof window === 'undefined') return DEFAULT_VIEWER_FONT_PERCENT
  const stored = Number(window.localStorage.getItem(VIEWER_FONT_STORAGE_KEY))
  if (!Number.isFinite(stored)) return DEFAULT_VIEWER_FONT_PERCENT
  return Math.min(
    Math.max(Math.round(stored), MIN_VIEWER_FONT_PERCENT),
    MAX_VIEWER_FONT_PERCENT,
  )
}

const ViewerPage = () => {
  const { viewerToken } = useParams()
  const location = useLocation()
  const query = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  )
  const resolvedViewerToken = viewerToken || query.get('viewer') || ''

  const [line, setLine] = useState(null)
  const [liveEntries, setLiveEntries] = useState([])
  const [liveLines, setLiveLines] = useState([])
  const [musicActive, setMusicActive] = useState(false)
  const [musicText, setMusicText] = useState('此處有音樂')
  const [displayEnabled, setDisplayEnabled] = useState(true)
  const [lineSource, setLineSource] = useState('script')
  const [waitingMessage, setWaitingMessage] = useState('')
  const [transcriptionIsFinal, setTranscriptionIsFinal] = useState(true)
  const [liveTranslationLanguages, setLiveTranslationLanguages] = useState([])
  const [transcriptionLanguage, setTranscriptionLanguage] = useState('zh-TW')
  const [transcriptionSourceLanguages, setTranscriptionSourceLanguages] =
    useState([])
  const [selectedLiveLanguage, setSelectedLiveLanguage] = useState(() => {
    if (typeof window === 'undefined') return 'source'
    return window.localStorage.getItem(VIEWER_LIVE_LANGUAGE_STORAGE_KEY) || 'source'
  })
  const [languages, setLanguages] = useState([])
  const [viewerDefaultLanguageId, setViewerDefaultLanguageId] = useState('primary')
  const [selectedLanguageId, setSelectedLanguageId] = useState('primary')
  const [hasLanguageOverride, setHasLanguageOverride] = useState(false)
  const [roleColorEnabled, setRoleColorEnabled] = useState(true)
  const [viewerFontPercent, setViewerFontPercent] = useState(
    getInitialViewerFontPercent,
  )
  const [fatalError, setFatalError] = useState('')
  const [connectionIssue, setConnectionIssue] = useState('')
  const [hasLoadedState, setHasLoadedState] = useState(false)
  const liveFeedRef = useRef(null)
  const socketRef = useRef(null)
  const hasLoadedStateRef = useRef(false)
  const recoveryTimerRef = useRef(null)
  const viewerRevisionRef = useRef({ sessionId: '', revision: 0 })
  const selectedLiveLanguageRef = useRef(selectedLiveLanguage)
  const lineSourceRef = useRef(lineSource)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      VIEWER_FONT_STORAGE_KEY,
      String(viewerFontPercent),
    )
  }, [viewerFontPercent])

  const clearRecoveryTimer = useCallback(() => {
    if (!recoveryTimerRef.current) return
    window.clearTimeout(recoveryTimerRef.current)
    recoveryTimerRef.current = null
  }, [])

  const applyViewerPayload = useCallback((payload) => {
    const incomingSessionId =
      typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    const incomingRevision = Number(payload?.viewerRevision)
    const previousRevision = viewerRevisionRef.current
    if (
      incomingSessionId &&
      previousRevision.sessionId === incomingSessionId &&
      Number.isSafeInteger(incomingRevision) &&
      incomingRevision < previousRevision.revision
    ) {
      return
    }
    if (incomingSessionId && Number.isSafeInteger(incomingRevision)) {
      viewerRevisionRef.current = {
        sessionId: incomingSessionId,
        revision: incomingRevision,
      }
    }
    const next = normalizeDisplayPayload(payload)
    setWaitingMessage(
      payload?.source === 'waiting'
        ? payload?.waitingMessage || '本場次尚未開始'
        : '',
    )
    setDisplayEnabled(next.enabled)
    setLine(next.line)
    setLiveEntries(next.liveEntries)
    setLiveLines(next.liveLines)
    setMusicActive(next.musicActive)
    setMusicText(next.musicText)
    lineSourceRef.current = next.source
    setLineSource(next.source)
    setLanguages(next.languages)
    setViewerDefaultLanguageId(
      resolveAvailableLanguageId(next.languages, next.defaultLanguageId),
    )
    setTranscriptionIsFinal(next.transcriptionIsFinal)
    setLiveTranslationLanguages(next.liveTranslationLanguages)
    setTranscriptionLanguage(next.transcriptionLanguage)
    setTranscriptionSourceLanguages(next.transcriptionSourceLanguages)
    setRoleColorEnabled(next.roleColorEnabled)
    hasLoadedStateRef.current = true
    setHasLoadedState(true)
    setConnectionIssue('')
    setFatalError('')
  }, [])

  const classifyPublicFailure = useCallback((response, data, fallbackMessage) => {
    const reason =
      typeof data?.reason === 'string' && data.reason.trim().length > 0
        ? data.reason.trim()
        : ''
    const message =
      data?.error || data?.message || fallbackMessage || '無法載入字幕'
    const isTerminalReason = reason === 'ended' || reason === 'deleted'
    const fatal =
      isTerminalReason ||
      (response?.status === 410 && !hasLoadedStateRef.current)

    return { fatal, message, reason }
  }, [])

  useEffect(() => {
    if (!resolvedViewerToken) {
      setFatalError('缺少檢視端連結')
      return
    }

    let cancelled = false
    const fetchViewerState = async () => {
      try {
        const response = await fetch(`/api/viewer/${resolvedViewerToken}?compact=1`)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const failure = classifyPublicFailure(response, data, '無法載入字幕')
          if (cancelled) return
          if (failure.fatal) {
            setFatalError(failure.message)
          } else {
            setConnectionIssue(failure.message)
          }
          return
        }
        if (!cancelled) {
          applyViewerPayload(data)
        }
      } catch (fetchError) {
        if (!cancelled) {
          setConnectionIssue(fetchError.message || '無法載入字幕')
        }
      }
    }

    void fetchViewerState()
    const intervalId = window.setInterval(() => {
      void fetchViewerState()
    }, PUBLIC_STATE_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearRecoveryTimer()
      window.clearInterval(intervalId)
    }
  }, [applyViewerPayload, classifyPublicFailure, clearRecoveryTimer, resolvedViewerToken])

  useEffect(() => {
    if (!resolvedViewerToken) return

    const socket = io()
    socketRef.current = socket
    const joinViewerSession = () => {
      socket.emit('join', { viewerToken: resolvedViewerToken, role: 'viewer' })
      socket.emit('viewer:live-language', {
        languageCode:
          lineSourceRef.current === 'transcription'
            ? selectedLiveLanguageRef.current
            : 'source',
      })
    }

    const fetchViewerState = async () => {
      try {
        const response = await fetch(`/api/viewer/${resolvedViewerToken}?compact=1`)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const failure = classifyPublicFailure(response, data, '無法載入字幕')
          if (failure.fatal) {
            setFatalError(failure.message)
          } else {
            setConnectionIssue(failure.message)
          }
          return
        }
        applyViewerPayload(data)
      } catch (error) {
        setConnectionIssue(error.message || '與伺服器重新同步失敗')
      }
    }

    const scheduleRecoveryFetch = (delayMs = PUBLIC_RECOVERY_RETRY_DELAY_MS) => {
      clearRecoveryTimer()
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null
        void fetchViewerState()
      }, delayMs)
    }

    socket.on('connect', () => {
      joinViewerSession()
      void fetchViewerState()
    })

    socket.on('disconnect', () => {
      if (hasLoadedStateRef.current) {
        setConnectionIssue('與伺服器連線中斷，正在重新連線')
      }
    })

    socket.on('viewer:update', (payload) => {
      applyViewerPayload(payload)
    })

    socket.on('viewer:expired', (payload) => {
      const reason =
        typeof payload?.reason === 'string' && payload.reason.trim()
          ? payload.reason.trim()
          : ''
      const message =
        typeof payload?.message === 'string' && payload.message.trim()
          ? payload.message.trim()
          : '本節目已結束'

      if (reason === 'ended' || reason === 'deleted' || !hasLoadedStateRef.current) {
        setFatalError(message)
        return
      }

      setConnectionIssue(message)
      scheduleRecoveryFetch()
    })

    const recoverVisibleViewer = () => {
      if (document.visibilityState === 'hidden') return
      if (!socket.connected) {
        socket.connect()
        return
      }
      // pageshow, online and visibilitychange often fire together. A healthy
      // socket is already in its room, so only coalesce a compact state fetch;
      // reconnecting or joining again creates an avoidable event storm.
      scheduleRecoveryFetch(150)
    }
    window.addEventListener('pageshow', recoverVisibleViewer)
    window.addEventListener('online', recoverVisibleViewer)
    document.addEventListener('visibilitychange', recoverVisibleViewer)

    return () => {
      window.removeEventListener('pageshow', recoverVisibleViewer)
      window.removeEventListener('online', recoverVisibleViewer)
      document.removeEventListener('visibilitychange', recoverVisibleViewer)
      clearRecoveryTimer()
      socketRef.current = null
      socket.disconnect()
    }
  }, [
    applyViewerPayload,
    classifyPublicFailure,
    clearRecoveryTimer,
    resolvedViewerToken,
  ])

  useEffect(() => {
    selectedLiveLanguageRef.current = selectedLiveLanguage
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        VIEWER_LIVE_LANGUAGE_STORAGE_KEY,
        selectedLiveLanguage,
      )
    }
    socketRef.current?.emit('viewer:live-language', {
      languageCode:
        lineSource === 'transcription' ? selectedLiveLanguage : 'source',
    })
  }, [lineSource, selectedLiveLanguage])

  useEffect(() => {
    lineSourceRef.current = lineSource
  }, [lineSource])

  useEffect(() => {
    if (!languages.length) return

    const fallbackLanguageId = resolveAvailableLanguageId(
      languages,
      viewerDefaultLanguageId,
    )
    const selectedLanguageStillAvailable =
      selectedLanguageId === ALL_LANGUAGES_OPTION_ID ||
      languages.some((language) => language.id === selectedLanguageId)

    if (!hasLanguageOverride) {
      if (selectedLanguageId !== fallbackLanguageId) {
        setSelectedLanguageId(fallbackLanguageId)
      }
      return
    }

    if (selectedLanguageStillAvailable) {
      return
    }

    setSelectedLanguageId(fallbackLanguageId)
    setHasLanguageOverride(false)
  }, [
    hasLanguageOverride,
    languages,
    selectedLanguageId,
    viewerDefaultLanguageId,
  ])

  useEffect(() => {
    if (!liveTranslationLanguages.length || selectedLiveLanguage === 'source') return
    if (
      !liveTranslationLanguages.some(
        (language) => language?.code === selectedLiveLanguage,
      ) || selectedLiveLanguage.toLowerCase() === transcriptionLanguage.toLowerCase()
    ) {
      setSelectedLiveLanguage('source')
    }
  }, [liveTranslationLanguages, selectedLiveLanguage, transcriptionLanguage])

  useEffect(() => {
    if (lineSource !== 'transcription') return
    const container = liveFeedRef.current
    if (!container) return

    const frameId = window.requestAnimationFrame(() => {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth',
      })
    })

    return () => window.cancelAnimationFrame(frameId)
  }, [lineSource, liveEntries, liveLines])

  const adjustViewerFontSize = (delta) => {
    setViewerFontPercent((prev) =>
      Math.min(
        Math.max(prev + delta, MIN_VIEWER_FONT_PERCENT),
        MAX_VIEWER_FONT_PERCENT,
      ),
    )
  }

  if (fatalError) {
    return (
      <div className="viewer-page">
        <div className="no-session">
          <h2>無法載入字幕</h2>
          <p>{fatalError}</p>
        </div>
      </div>
    )
  }

  if (!hasLoadedState && connectionIssue) {
    return (
      <div className="viewer-page">
        <div className="no-session">
          <h2>正在重新連線</h2>
          <p>{connectionIssue}</p>
        </div>
      </div>
    )
  }

  if (waitingMessage) {
    return (
      <div className="viewer-page">
        <div className="no-session">
          <h2>{waitingMessage}</h2>
          <p>控制端開始此場次後，字幕會自動顯示。</p>
        </div>
      </div>
    )
  }

  const isStageDirection = displayEnabled && line && line.type === 'direction'
  const displayText = displayEnabled
    ? isStageDirection
      ? '\u00a0'
      : selectedLanguageId === ALL_LANGUAGES_OPTION_ID
        ? resolveLanguageDisplayList(languages, viewerDefaultLanguageId, 'all')
            .map((language) => ({
              id: language.id,
              name: language.name,
              text: resolveLineText(line, language.id),
            }))
            .filter((entry) => entry.text.trim())
        : resolveLineText(line, selectedLanguageId)
    : '\u00a0'

  const textClass = `viewer-text${
    displayEnabled ? '' : ' viewer-muted'
  }${isStageDirection ? ' viewer-direction' : ''}${
    lineSource === 'transcription' ? ' viewer-live' : ''
  }`

  const roleColor =
    roleColorEnabled && !isStageDirection ? roleToColor(line?.role) : ''
  const liveFeedClassName = `viewer-live-feed${
    musicActive ? ' with-music-banner' : ''
  }`
  const viewerFontScale = viewerFontPercent / 100
  const selectedLanguageName =
    selectedLanguageId === ALL_LANGUAGES_OPTION_ID
      ? '全部語言'
      : languages.find((language) => language.id === selectedLanguageId)?.name || '語言'
  const selectedLiveLanguageDefinition = liveTranslationLanguages.find(
    (language) => language?.code === selectedLiveLanguage,
  )
  const sourceLanguageDefinition = transcriptionSourceLanguages.find(
    (language) =>
      language?.code?.toLowerCase() === transcriptionLanguage.toLowerCase(),
  )
  const sourceLanguageLabel =
    sourceLanguageDefinition?.originalLabel ||
    `Original (${sourceLanguageDefinition?.name || transcriptionLanguage})`
  const availableLiveTranslationLanguages = liveTranslationLanguages.filter(
    (language) =>
      language?.code?.toLowerCase() !== transcriptionLanguage.toLowerCase(),
  )
  const selectedLiveLanguageName =
    selectedLiveLanguage === 'source'
      ? sourceLanguageLabel
      : selectedLiveLanguageDefinition?.name || selectedLiveLanguage.toUpperCase()
  const selectedLiveLanguageUi = selectedLiveLanguageDefinition?.ui || {
    live: `Live translation: ${selectedLiveLanguageName}`,
  }
  const visibleLiveEntries = (liveEntries.length > 0
    ? liveEntries
    : liveLines.map((text) => ({
        id: '',
        text,
        translations: {},
        speakerId: null,
        isFinal: transcriptionIsFinal,
      })))
    .map((entry) => ({
      ...entry,
      displayText:
        selectedLiveLanguage === 'source'
          ? entry.text
          : entry.translations?.[selectedLiveLanguage] || '',
    }))
    .filter((entry) => entry.displayText)

  return (
    <div
      className="viewer-page"
      style={{ '--viewer-font-scale': viewerFontScale }}
    >
      <div className="viewer-toolbar">
        <div className="viewer-toolbar-group viewer-font-controls">
          <button
            type="button"
            className="viewer-toolbar-button"
            onClick={() => adjustViewerFontSize(-VIEWER_FONT_STEP)}
            disabled={viewerFontPercent <= MIN_VIEWER_FONT_PERCENT}
            aria-label="縮小字體"
          >
            −
          </button>
          <button
            type="button"
            className="viewer-toolbar-button"
            onClick={() => adjustViewerFontSize(VIEWER_FONT_STEP)}
            disabled={viewerFontPercent >= MAX_VIEWER_FONT_PERCENT}
            aria-label="放大字體"
          >
            +
          </button>
        </div>

        {(lineSource === 'transcription' || languages.length > 1) && (
          <label
            className="viewer-language-menu"
            title={
              lineSource === 'transcription'
                ? selectedLiveLanguageName
                : selectedLanguageName
            }
            aria-label="切換語言"
          >
            <span aria-hidden="true">▾</span>
            <select
              value={
                lineSource === 'transcription'
                  ? selectedLiveLanguage
                  : selectedLanguageId
              }
              onChange={(event) => {
                if (lineSource === 'transcription') {
                  setSelectedLiveLanguage(event.target.value)
                } else {
                  setSelectedLanguageId(event.target.value)
                  setHasLanguageOverride(true)
                }
              }}
              aria-label="切換語言"
            >
              {lineSource === 'transcription' ? (
                <>
                  <option value="source">{sourceLanguageLabel}</option>
                  {availableLiveTranslationLanguages.map((language) => (
                    <option key={language.code} value={language.code}>
                      {language.name}
                    </option>
                  ))}
                </>
              ) : (
                <>
                  <option value={ALL_LANGUAGES_OPTION_ID}>全部語言</option>
                  {languages.map((language) => (
                    <option key={language.id} value={language.id}>
                      {language.name}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
        )}

      </div>

      {displayEnabled && musicActive && (
        <div
          className="viewer-music-banner viewer-music-banner--music"
          role="status"
          aria-live="polite"
        >
          <div className="viewer-music-banner-inner">
            <span className="viewer-music-label">音樂提示</span>
            <span className="viewer-music-text">{musicText}</span>
          </div>
        </div>
      )}

      {connectionIssue && hasLoadedState && (
        <div className="viewer-music-banner" role="status" aria-live="polite">
          <div className="viewer-music-banner-inner">
            <span className="viewer-music-label">連線狀態</span>
            <span className="viewer-music-text">{connectionIssue}</span>
          </div>
        </div>
      )}

      {lineSource === 'transcription' && displayEnabled && (
        <div className="viewer-live-badge">
          {selectedLiveLanguage === 'source'
            ? transcriptionIsFinal
              ? '即時語音 最終稿'
              : '即時語音 草稿'
            : selectedLiveLanguageUi.live}
        </div>
      )}

      {lineSource === 'transcription' && displayEnabled ? (
        <div className={liveFeedClassName} ref={liveFeedRef}>
          {visibleLiveEntries.map((liveEntry, index, entries) => {
            const isLatest = index === entries.length - 1
            const speakerClass =
              Number.isInteger(liveEntry.speakerId) && liveEntry.speakerId > 0
                ? ` viewer-speaker-${((liveEntry.speakerId - 1) % 6) + 1}`
                : ''
            return (
              <div
                key={liveEntry.id || `${index}-${liveEntry.displayText}`}
                className={`viewer-live-line${speakerClass}${
                  isLatest ? ' viewer-live-line-active' : ''
                }${
                  liveEntry.isFinal && isLatest
                    ? ' viewer-live-line-final'
                    : ''
                }`}
              >
                {liveEntry.displayText}
              </div>
            )
          })}
        </div>
      ) : (
        <div className={textClass} style={roleColor ? { color: roleColor } : undefined}>
          {Array.isArray(displayText)
            ? displayText.map((entry) => (
                <div key={entry.id} className="viewer-language-line">
                  <span>{entry.name}</span>
                  <strong>{entry.text}</strong>
                </div>
              ))
            : displayText}
        </div>
      )}
    </div>
  )
}

export default ViewerPage
