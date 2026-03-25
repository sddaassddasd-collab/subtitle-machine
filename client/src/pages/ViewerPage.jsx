import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  normalizeDisplayPayload,
  resolveLineText,
  roleToColor,
} from '../lib/displayPayload'

const VIEWER_FONT_STORAGE_KEY = 'subtitleMachineViewerFontPercent'
const DEFAULT_VIEWER_FONT_PERCENT = 100
const MIN_VIEWER_FONT_PERCENT = 70
const MAX_VIEWER_FONT_PERCENT = 180
const VIEWER_FONT_STEP = 10

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
  const [selectedLanguageId, setSelectedLanguageId] = useState('primary')
  const [roleColorEnabled, setRoleColorEnabled] = useState(true)
  const [viewerFontPercent, setViewerFontPercent] = useState(
    getInitialViewerFontPercent,
  )
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const containerRef = useRef(null)
  const liveFeedRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      VIEWER_FONT_STORAGE_KEY,
      String(viewerFontPercent),
    )
  }, [viewerFontPercent])

  useEffect(() => {
    if (!resolvedViewerToken) {
      setError('缺少檢視端連結')
      return
    }

    let cancelled = false
    const fetchInitialState = async () => {
      try {
        const response = await fetch(`/api/viewer/${resolvedViewerToken}`)
        if (!response.ok) {
          throw new Error('場次不存在或已結束')
        }
        const data = await response.json()
        if (!cancelled) {
          const next = normalizeDisplayPayload(data)
          setDisplayEnabled(next.enabled)
          setLine(next.line)
          setLiveEntries(next.liveEntries)
          setLiveLines(next.liveLines)
          setMusicActive(next.musicActive)
          setMusicText(next.musicText)
          setLineSource(next.source)
          setLanguages(next.languages)
          setTranscriptionIsFinal(next.transcriptionIsFinal)
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError.message || '無法載入字幕')
        }
      }
    }

    fetchInitialState()
    return () => {
      cancelled = true
    }
  }, [resolvedViewerToken])

  useEffect(() => {
    if (!resolvedViewerToken) return

    const socket = io()
    socket.emit('join', { viewerToken: resolvedViewerToken, role: 'viewer' })

    socket.on('viewer:update', (payload) => {
      const next = normalizeDisplayPayload(payload)
      setDisplayEnabled(next.enabled)
      setLine(next.line)
      setLiveEntries(next.liveEntries)
      setLiveLines(next.liveLines)
      setMusicActive(next.musicActive)
      setMusicText(next.musicText)
      setLineSource(next.source)
      setLanguages(next.languages)
      setTranscriptionIsFinal(next.transcriptionIsFinal)
      setError('')
    })

    socket.on('viewer:expired', (payload) => {
      setError(
        typeof payload?.message === 'string'
          ? payload.message
          : '本場次已結束',
      )
    })

    return () => {
      socket.disconnect()
    }
  }, [resolvedViewerToken])

  useEffect(() => {
    if (!languages.length) return
    if (languages.some((language) => language.id === selectedLanguageId)) return
    setSelectedLanguageId(languages[0]?.id || 'primary')
  }, [languages, selectedLanguageId])

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

  useEffect(() => {
    const handler = () => {
      const active =
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
      setIsFullscreen(Boolean(active))
    }

    document.addEventListener('fullscreenchange', handler)
    document.addEventListener('webkitfullscreenchange', handler)
    document.addEventListener('mozfullscreenchange', handler)
    document.addEventListener('MSFullscreenChange', handler)
    return () => {
      document.removeEventListener('fullscreenchange', handler)
      document.removeEventListener('webkitfullscreenchange', handler)
      document.removeEventListener('mozfullscreenchange', handler)
      document.removeEventListener('MSFullscreenChange', handler)
    }
  }, [])

  const requestFullscreen = (element) => {
    if (!element) return Promise.reject(new Error('No element'))
    const method =
      element.requestFullscreen ||
      element.webkitRequestFullscreen ||
      element.mozRequestFullScreen ||
      element.msRequestFullscreen
    if (method) {
      const result = method.call(element)
      if (result?.catch) {
        result.catch(() => {})
      }
      return result || Promise.resolve()
    }
    return Promise.reject(new Error('Fullscreen not supported'))
  }

  const exitFullscreen = () => {
    const exitMethod =
      document.exitFullscreen ||
      document.webkitExitFullscreen ||
      document.mozCancelFullScreen ||
      document.msExitFullscreen
    if (exitMethod) {
      const result = exitMethod.call(document)
      if (result?.catch) {
        result.catch(() => {})
      }
      return result || Promise.resolve()
    }
    return Promise.reject(new Error('Exit fullscreen not supported'))
  }

  const toggleFullscreen = () => {
    const container = containerRef.current
    if (!container) return

    const active =
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      document.mozFullScreenElement ||
      document.msFullscreenElement

    if (!active) {
      requestFullscreen(container)
    } else {
      exitFullscreen().catch(() => {})
    }
  }

  const adjustViewerFontSize = (delta) => {
    setViewerFontPercent((prev) =>
      Math.min(
        Math.max(prev + delta, MIN_VIEWER_FONT_PERCENT),
        MAX_VIEWER_FONT_PERCENT,
      ),
    )
  }

  if (error) {
    return (
      <div className="viewer-page">
        <div className="no-session">
          <h2>無法載入字幕</h2>
          <p>{error}</p>
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
      ref={containerRef}
      style={{ '--viewer-font-scale': viewerFontScale }}
    >
      <button
        type="button"
        className="fullscreen-button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        ⛶
      </button>

      <div className="viewer-toolbar">
        <div className="viewer-toolbar-group viewer-font-controls">
          <span>字級</span>
          <button
            type="button"
            className="viewer-toolbar-button"
            onClick={() => adjustViewerFontSize(-VIEWER_FONT_STEP)}
            disabled={viewerFontPercent <= MIN_VIEWER_FONT_PERCENT}
            aria-label="縮小字體"
          >
            −
          </button>
          <span className="viewer-font-value">{viewerFontPercent}%</span>
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
              onChange={(event) => setSelectedLanguageId(event.target.value)}
            >
              {languages.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="viewer-toolbar-check">
          <input
            type="checkbox"
            checked={roleColorEnabled}
            onChange={(event) => setRoleColorEnabled(event.target.checked)}
          />
          顏色分辨角色
        </label>
      </div>

      {displayEnabled && musicActive && (
        <div className="viewer-music-banner" role="status" aria-live="polite">
          <div className="viewer-music-banner-inner">
            <span className="viewer-music-label">音樂提示</span>
            <span className="viewer-music-text">{musicText}</span>
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
