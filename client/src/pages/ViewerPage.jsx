import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import FollowPrompter from '../components/FollowPrompter'
import { PublicDisplayGate, publicViewMode, preventPrompterScroll } from '../lib/public-display'
import { io } from 'socket.io-client'
import { useAutoFollowDisplayAck } from '../lib/useAutoFollowDisplayAck'
import {
  normalizeDisplayPayload,
  normalizeLiveTranslationPatch,
  resolveAvailableLanguageId,
  resolveLineText,
  roleToColor,
} from '../lib/displayPayload'

const VIEWER_FONT_STORAGE_KEY = 'subtitleMachineViewerFontPercent'
const PROMPTER_FONT_STORAGE_KEY = 'subtitleMachinePrompterFontPercent'
const VIEWER_LIVE_LANGUAGE_STORAGE_KEY = 'subtitleMachineViewerLiveLanguage'
const DEFAULT_VIEWER_FONT_PERCENT = 100
const MIN_VIEWER_FONT_PERCENT = 70
const MAX_VIEWER_FONT_PERCENT = 180
const VIEWER_FONT_STEP = 10
const PUBLIC_RECOVERY_RETRY_DELAY_MS = 1200
const PUBLIC_RECOVERY_JITTER_MS = 600

const getInitialViewerFontPercent = (key = VIEWER_FONT_STORAGE_KEY) => {
  if (typeof window === 'undefined') return DEFAULT_VIEWER_FONT_PERCENT
  const value = window.localStorage.getItem(key)
  const stored = value === null ? DEFAULT_VIEWER_FONT_PERCENT : Number(value)
  if (!Number.isFinite(stored)) return DEFAULT_VIEWER_FONT_PERCENT
  return Math.min(
    Math.max(Math.round(stored), MIN_VIEWER_FONT_PERCENT),
    MAX_VIEWER_FONT_PERCENT,
  )
}

const ViewerPage = () => {
  const { viewerToken } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const mode = publicViewMode(location.search)
  const isPrompter = mode === 'prompter'
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
    () => getInitialViewerFontPercent(),
  )
  const [prompterFontPercent, setPrompterFontPercent] = useState(() => getInitialViewerFontPercent(PROMPTER_FONT_STORAGE_KEY))
  const [cueWindow, setCueWindow] = useState(null)
  const [currentIndex, setCurrentIndex] = useState(0)
  const pageRef = useRef(null)
  const gateRef = useRef(null)
  if (!gateRef.current) gateRef.current = new PublicDisplayGate(mode)
  const rejoinRef = useRef(null)
  const [fatalError, setFatalError] = useState('')
  const [connectionIssue, setConnectionIssue] = useState('')
  const [hasLoadedState, setHasLoadedState] = useState(false)
  const liveFeedRef = useRef(null)
  const socketRef = useRef(null)
  const observeAutoFollowDisplay = useAutoFollowDisplayAck(socketRef, `${resolvedViewerToken}:${mode}`)
  const hasLoadedStateRef = useRef(false)
  const recoveryTimerRef = useRef(null)
  const selectedLiveLanguageRef = useRef(selectedLiveLanguage)
  const lineSourceRef = useRef(lineSource)
  const liveTranslationPatchRef = useRef({ streamId: '', revision: 0 })
  const liveTranscriptionPatchRef = useRef({ streamId: '', revision: 0 })

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      VIEWER_FONT_STORAGE_KEY,
      String(viewerFontPercent),
    )
  }, [viewerFontPercent])

  useEffect(() => {
    window.localStorage.setItem(PROMPTER_FONT_STORAGE_KEY, String(prompterFontPercent))
  }, [prompterFontPercent])

  useEffect(() => {
    const gate = gateRef.current
    if (gate.mode === mode) return
    gate.select(mode)
    setCueWindow(null)
    observeAutoFollowDisplay(null)
    rejoinRef.current?.()
  }, [mode, observeAutoFollowDisplay])

  useEffect(() => {
    if (!isPrompter || fatalError) return
    const page = pageRef.current
    const htmlOverflow = document.documentElement.style.overflow
    const bodyOverflow = document.body.style.overflow
    document.documentElement.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    page?.addEventListener('wheel', preventPrompterScroll, { passive: false })
    page?.addEventListener('touchmove', preventPrompterScroll, { passive: false })
    document.addEventListener('keydown', preventPrompterScroll)
    return () => {
      document.documentElement.style.overflow = htmlOverflow
      document.body.style.overflow = bodyOverflow
      page?.removeEventListener('wheel', preventPrompterScroll)
      page?.removeEventListener('touchmove', preventPrompterScroll)
      document.removeEventListener('keydown', preventPrompterScroll)
    }
  }, [isPrompter, fatalError, hasLoadedState, connectionIssue])

  const clearRecoveryTimer = useCallback(() => {
    if (!recoveryTimerRef.current) return
    window.clearTimeout(recoveryTimerRef.current)
    recoveryTimerRef.current = null
  }, [])

  const applyViewerPayload = useCallback((payload, requestedMode, generation) => {
    if (!gateRef.current.accepts(payload, requestedMode, generation)) return
    const next = normalizeDisplayPayload(payload)
    setCueWindow(next.cueWindow)
    setCurrentIndex(next.currentIndex)
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
    observeAutoFollowDisplay(payload)
  }, [observeAutoFollowDisplay])

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

    gateRef.current.reset()
    hasLoadedStateRef.current = false
    setHasLoadedState(false)
    setCueWindow(null)
    liveTranscriptionPatchRef.current = { streamId: '', revision: 0 }
    liveTranslationPatchRef.current = { streamId: '', revision: 0 }
    let active = true
    const socket = io()
    socketRef.current = socket
    const joinViewerSession = () => {
      if (!socket.connected) return
      const role = gateRef.current.mode === 'prompter' ? 'prompter' : 'viewer'
      socket.emit('join', { viewerToken: resolvedViewerToken, role, followOnly: role === 'prompter' })
      socket.emit('viewer:live-language', {
        languageCode:
          lineSourceRef.current === 'transcription'
            ? selectedLiveLanguageRef.current
            : 'source',
      })
    }

    rejoinRef.current = joinViewerSession

    const fetchViewerState = async () => {
      const { mode: requestedMode, generation } = gateRef.current
      const stillCurrent = () => active && requestedMode === gateRef.current.mode && generation === gateRef.current.generation
      try {
        const response = await fetch(
          `/api/viewer/${encodeURIComponent(resolvedViewerToken)}${requestedMode === 'prompter' ? '?followOnly=1' : ''}`,
        )
        const data = await response.json().catch(() => ({}))
        if (!stillCurrent()) return
        if (!response.ok) {
          const failure = classifyPublicFailure(response, data, '無法載入字幕')
          if (failure.fatal) {
            setFatalError(failure.message)
          } else {
            setConnectionIssue(failure.message)
          }
          return
        }
        applyViewerPayload(data, requestedMode, generation)
      } catch (error) {
        if (!stillCurrent()) return
        setConnectionIssue(error.message || '與伺服器重新同步失敗')
      }
    }

    const scheduleRecoveryFetch = () => {
      clearRecoveryTimer()
      recoveryTimerRef.current = window.setTimeout(
        () => {
          recoveryTimerRef.current = null
          void fetchViewerState()
        },
        PUBLIC_RECOVERY_RETRY_DELAY_MS +
          Math.floor(Math.random() * PUBLIC_RECOVERY_JITTER_MS),
      )
    }

    socket.on('connect', () => {
      clearRecoveryTimer()
      setConnectionIssue('')
      joinViewerSession()
    })

    socket.on('disconnect', () => {
      if (hasLoadedStateRef.current) {
        setConnectionIssue('與伺服器連線中斷，正在重新連線')
      }
      scheduleRecoveryFetch()
    })

    socket.on('connect_error', () => {
      if (hasLoadedStateRef.current) {
        setConnectionIssue('與伺服器連線不穩，正在重新連線')
      }
      scheduleRecoveryFetch()
    })

    socket.on('viewer:update', payload => applyViewerPayload(payload, 'viewer'))
    socket.on('prompter:update', payload => applyViewerPayload(payload, 'prompter'))

    const applyLiveUpdate = (payload, requestedMode) => {
      if (requestedMode !== gateRef.current.mode) return
      const streamId =
        typeof payload?.streamId === 'string' ? payload.streamId : ''
      const revision = Number.isSafeInteger(payload?.revision)
        ? payload.revision
        : 0
      if (!streamId || revision <= 0 || payload?.active !== true) return
      const previous = liveTranscriptionPatchRef.current
      if (previous.streamId === streamId && revision <= previous.revision) {
        return
      }
      liveTranscriptionPatchRef.current = { streamId, revision }

      const next = normalizeDisplayPayload(payload)
      setDisplayEnabled(next.enabled)
      setCueWindow(null)
      setMusicActive(false)
      setLine(next.line)
      setLiveEntries(next.liveEntries)
      setLiveLines(next.liveLines)
      setTranscriptionIsFinal(next.transcriptionIsFinal)
      setLiveTranslationLanguages(next.liveTranslationLanguages)
      setTranscriptionLanguage(next.transcriptionLanguage)
      setTranscriptionSourceLanguages(next.transcriptionSourceLanguages)
      lineSourceRef.current = 'transcription'
      setLineSource('transcription')
      setWaitingMessage('')
      hasLoadedStateRef.current = true
      setHasLoadedState(true)
      setConnectionIssue('')
    }
    socket.on('viewer:live-update', payload => applyLiveUpdate(payload, 'viewer'))
    socket.on('prompter:live-update', payload => applyLiveUpdate(payload, 'prompter'))

    socket.on('viewer:translation-patch', (payload) => {
      const patch = normalizeLiveTranslationPatch(payload)
      if (
        !patch.streamId ||
        patch.languageCode !== selectedLiveLanguageRef.current ||
        lineSourceRef.current !== 'transcription'
      ) {
        return
      }
      const previous = liveTranslationPatchRef.current
      if (
        previous.streamId === patch.streamId &&
        patch.revision <= previous.revision
      ) {
        return
      }
      liveTranslationPatchRef.current = {
        streamId: patch.streamId,
        revision: patch.revision,
      }
      setLiveEntries(patch.liveEntries)
      setLiveLines(patch.liveLines)
      setTranscriptionIsFinal(patch.transcriptionIsFinal)
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

    const recoverConnection = () => {
      if (document.visibilityState === 'hidden') return
      if (socket.connected) {
        joinViewerSession()
        return
      }
      socket.connect()
      scheduleRecoveryFetch()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverConnection()
    }
    window.addEventListener('online', recoverConnection)
    window.addEventListener('pageshow', recoverConnection)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      active = false
      rejoinRef.current = null
      clearRecoveryTimer()
      window.removeEventListener('online', recoverConnection)
      window.removeEventListener('pageshow', recoverConnection)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
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
    if (selectedLiveLanguage === 'source') return
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

  const fontPercent = isPrompter ? prompterFontPercent : viewerFontPercent
  const adjustViewerFontSize = (delta) => {
    const setFont = isPrompter ? setPrompterFontPercent : setViewerFontPercent
    setFont((prev) =>
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

  const isStageDirection = displayEnabled && line && line.type === 'direction'
  const displayText = displayEnabled
    ? isStageDirection
      ? '\u00a0'
      : resolveLineText(line, resolveAvailableLanguageId(
          languages,
          languages.some(language => language.id === selectedLanguageId)
            ? selectedLanguageId : viewerDefaultLanguageId,
        ))
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
    languages.find((language) => language.id === selectedLanguageId)?.name || '語言'
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
      ref={pageRef}
      className={`viewer-page public-display${isPrompter ? ' viewer-page--prompter' : ''}`}
      style={{ '--viewer-font-scale': viewerFontScale }}
    >
      <header className="public-display-header">
        <div className="viewer-toolbar">
          <div className="viewer-mode-switch" role="group" aria-label="顯示模式">
            {['viewer', 'prompter'].map(nextMode => <button key={nextMode} type="button"
              className="viewer-toolbar-button" aria-pressed={mode === nextMode}
              onClick={() => {
                const params = new URLSearchParams(location.search)
                if (nextMode === 'prompter') params.set('mode', 'prompter')
                else params.delete('mode')
                navigate({ pathname: location.pathname, search: params.toString() }, { replace: true })
              }}>{nextMode === 'viewer' ? '觀眾模式' : '提詞模式'}</button>)}
          </div>
          <div className="viewer-toolbar-group viewer-font-controls">
            <button
              type="button"
              className="viewer-toolbar-button"
              onClick={() => adjustViewerFontSize(-VIEWER_FONT_STEP)}
              disabled={fontPercent <= MIN_VIEWER_FONT_PERCENT}
              aria-label="縮小字體"
            >
              −
            </button>
            <button
              type="button"
              className="viewer-toolbar-button"
              onClick={() => adjustViewerFontSize(VIEWER_FONT_STEP)}
              disabled={fontPercent >= MAX_VIEWER_FONT_PERCENT}
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

      </header>

      {waitingMessage ? (
        <div className="no-session"><h2>{waitingMessage}</h2><p>控制端開始此場次後，字幕會自動顯示。</p></div>
      ) : isPrompter ? (
        <FollowPrompter enabled={hasLoadedState && displayEnabled} line={line} currentIndex={currentIndex}
          cueWindow={cueWindow} languageId={resolveAvailableLanguageId(languages, selectedLanguageId)}
          roleColorEnabled={roleColorEnabled} live={lineSource === 'transcription'}
          liveEntries={visibleLiveEntries} fontPercent={prompterFontPercent} />
      ) : lineSource === 'transcription' && displayEnabled ? (
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
          {displayText}
        </div>
      )}
    </div>
  )
}

export default ViewerPage
