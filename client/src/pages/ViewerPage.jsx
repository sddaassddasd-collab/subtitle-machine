import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { io } from 'socket.io-client'

const DEFAULT_SESSION_ID = 'default'

const normalizeViewerPayload = (payload) => {
  const enabled =
    typeof payload?.displayEnabled === 'boolean'
      ? payload.displayEnabled
      : true

  const lineCandidate = payload?.line
  const nextLine =
    lineCandidate && typeof lineCandidate === 'object'
      ? {
          text: lineCandidate.text || '',
          type:
            lineCandidate.type === 'direction' ? 'direction' : 'dialogue',
        }
      : typeof payload?.text === 'string'
        ? { text: payload.text, type: 'dialogue' }
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
    transcriptionIsFinal,
  }
}

const ViewerPage = () => {
  const location = useLocation()
  const query = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  )
  const sessionId = query.get('session') || DEFAULT_SESSION_ID

  const [line, setLine] = useState(null)
  const [liveEntries, setLiveEntries] = useState([])
  const [liveLines, setLiveLines] = useState([])
  const [musicActive, setMusicActive] = useState(false)
  const [musicText, setMusicText] = useState('此處有音樂')
  const [displayEnabled, setDisplayEnabled] = useState(true)
  const [lineSource, setLineSource] = useState('script')
  const [transcriptionIsFinal, setTranscriptionIsFinal] = useState(true)
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const containerRef = useRef(null)
  const liveFeedRef = useRef(null)

  useEffect(() => {
    if (!sessionId) return

    let cancelled = false
    const fetchInitialState = async () => {
      try {
        const response = await fetch(`/api/session/${sessionId}/viewer`)
        if (!response.ok) {
          throw new Error('場次不存在或已關閉')
        }
        const data = await response.json()
        if (!cancelled) {
          const next = normalizeViewerPayload(data)
          setDisplayEnabled(next.enabled)
          setLine(next.line)
          setLiveEntries(next.liveEntries)
          setLiveLines(next.liveLines)
          setMusicActive(next.musicActive)
          setMusicText(next.musicText)
          setLineSource(next.source)
          setTranscriptionIsFinal(next.transcriptionIsFinal)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || '無法載入字幕')
        }
      }
    }

    fetchInitialState()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) return

    const socket = io()

    socket.emit('join', { sessionId, role: 'viewer' })
    socket.on('viewer:update', (payload) => {
      const next = normalizeViewerPayload(payload)
      setDisplayEnabled(next.enabled)
      setLine(next.line)
      setLiveEntries(next.liveEntries)
      setLiveLines(next.liveLines)
      setMusicActive(next.musicActive)
      setMusicText(next.musicText)
      setLineSource(next.source)
      setTranscriptionIsFinal(next.transcriptionIsFinal)
    })

    return () => {
      socket.disconnect()
    }
  }, [sessionId])

  useEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        window.location.reload()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () =>
      document.removeEventListener(
        'visibilitychange',
        handleVisibilityChange,
      )
  }, [])

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
      if (result && result.catch) {
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
      if (result && result.catch) {
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

  const isStageDirection =
    displayEnabled && line && line.type === 'direction'
  const textClass = `viewer-text${
    displayEnabled ? '' : ' viewer-muted'
  }${isStageDirection ? ' viewer-direction' : ''}${
    lineSource === 'transcription' ? ' viewer-live' : ''
  }`
  const displayText = displayEnabled
    ? isStageDirection
      ? '\u00a0'
      : line?.text || ''
    : '字幕暫停中'
  const latestLiveLine =
    liveLines.length > 0 ? liveLines[liveLines.length - 1] : ''

  return (
    <div className="viewer-page" ref={containerRef}>
      <button
        type="button"
        className="fullscreen-button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        ⛶
      </button>
      {displayEnabled && musicActive && (
        <div
          className={`viewer-music-badge${
            lineSource === 'transcription' ? ' with-live-badge' : ''
          }`}
        >
          {musicText}
        </div>
      )}
      {lineSource === 'transcription' && displayEnabled && (
        <div className="viewer-live-badge">
          {transcriptionIsFinal ? '即時語音 最終稿' : '即時語音 草稿'}
        </div>
      )}
      {lineSource === 'transcription' && displayEnabled ? (
        <div className="viewer-live-feed" ref={liveFeedRef}>
          {(liveEntries.length > 0 ? liveEntries : liveLines.map((text) => ({
            text,
            speakerId: null,
            isFinal: transcriptionIsFinal,
          }))).map((liveEntry, index, entries) => {
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
          {liveLines.length === 0 && (
            <div className="viewer-live-line viewer-live-line-active">
              {latestLiveLine || displayText}
            </div>
          )}
        </div>
      ) : (
        <div className={textClass}>{displayText}</div>
      )}
    </div>
  )
}

export default ViewerPage
