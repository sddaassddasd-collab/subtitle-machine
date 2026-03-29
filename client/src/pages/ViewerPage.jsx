import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  normalizeDisplayPayload,
  resolveAvailableLanguageId,
  resolveLineText,
  roleToColor,
} from '../lib/displayPayload'

const VIEWER_FONT_STORAGE_KEY = 'subtitleMachineViewerFontPercent'
const DEFAULT_VIEWER_FONT_PERCENT = 100
const MIN_VIEWER_FONT_PERCENT = 70
const MAX_VIEWER_FONT_PERCENT = 180
const VIEWER_FONT_STEP = 10
const PUBLIC_STATE_REFRESH_INTERVAL_MS = 15000
const PUBLIC_RECOVERY_RETRY_DELAY_MS = 1200

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
  const [transcriptionIsFinal, setTranscriptionIsFinal] = useState(true)
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
  const hasLoadedStateRef = useRef(false)
  const recoveryTimerRef = useRef(null)

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
    const next = normalizeDisplayPayload(payload)
    setDisplayEnabled(next.enabled)
    setLine(next.line)
    setLiveEntries(next.liveEntries)
    setLiveLines(next.liveLines)
    setMusicActive(next.musicActive)
    setMusicText(next.musicText)
    setLineSource(next.source)
    setLanguages(next.languages)
    setViewerDefaultLanguageId(
      resolveAvailableLanguageId(next.languages, next.defaultLanguageId),
    )
    setTranscriptionIsFinal(next.transcriptionIsFinal)
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
        const response = await fetch(`/api/viewer/${resolvedViewerToken}`)
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
    const joinViewerSession = () => {
      socket.emit('join', { viewerToken: resolvedViewerToken, role: 'viewer' })
    }

    const fetchViewerState = async () => {
      try {
        const response = await fetch(`/api/viewer/${resolvedViewerToken}`)
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

    const scheduleRecoveryFetch = () => {
      clearRecoveryTimer()
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null
        void fetchViewerState()
      }, PUBLIC_RECOVERY_RETRY_DELAY_MS)
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
          : '本場次已結束'

      if (reason === 'ended' || reason === 'deleted' || !hasLoadedStateRef.current) {
        setFatalError(message)
        return
      }

      setConnectionIssue(message)
      scheduleRecoveryFetch()
    })

    return () => {
      clearRecoveryTimer()
      socket.disconnect()
    }
  }, [applyViewerPayload, classifyPublicFailure, clearRecoveryTimer, resolvedViewerToken])

  useEffect(() => {
    if (!languages.length) return

    const fallbackLanguageId = resolveAvailableLanguageId(
      languages,
      viewerDefaultLanguageId,
    )
    const selectedLanguageStillAvailable = languages.some(
      (language) => language.id === selectedLanguageId,
    )

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

  const isStageDirection = displayEnabled && line && line.type === 'direction'
  const displayText = displayEnabled
    ? isStageDirection
      ? '\u00a0'
      : resolveLineText(line, selectedLanguageId)
    : '字幕暫停中'

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

        {languages.length > 1 && (
          <label className="viewer-toolbar-group">
            <span>語言</span>
            <select
              value={selectedLanguageId}
              onChange={(event) => {
                setSelectedLanguageId(event.target.value)
                setHasLanguageOverride(true)
              }}
            >
              {languages.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.name}
                </option>
              ))}
            </select>
          </label>
        )}

      </div>

      {displayEnabled && musicActive && (
        <div className="viewer-music-banner" role="status" aria-live="polite">
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
          {transcriptionIsFinal ? '即時語音 最終稿' : '即時語音 草稿'}
        </div>
      )}

      {lineSource === 'transcription' && displayEnabled ? (
        <div className={liveFeedClassName} ref={liveFeedRef}>
          {(liveEntries.length > 0
            ? liveEntries
            : liveLines.map((text) => ({
                text,
                speakerId: null,
                isFinal: transcriptionIsFinal,
              }))
          ).map((liveEntry, index, entries) => {
            const isLatest = index === entries.length - 1
            const speakerClass =
              Number.isInteger(liveEntry.speakerId) && liveEntry.speakerId > 0
                ? ` viewer-speaker-${((liveEntry.speakerId - 1) % 6) + 1}`
                : ''
            return (
              <div
                key={`${index}-${liveEntry.text}`}
                className={`viewer-live-line${speakerClass}${
                  isLatest ? ' viewer-live-line-active' : ''
                }${
                  liveEntry.isFinal && isLatest
                    ? ' viewer-live-line-final'
                    : ''
                }`}
              >
                {liveEntry.text}
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
