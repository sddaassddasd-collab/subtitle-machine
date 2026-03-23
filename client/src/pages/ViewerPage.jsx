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

  return {
    enabled,
    line: nextLine,
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
  const [displayEnabled, setDisplayEnabled] = useState(true)
  const [lineSource, setLineSource] = useState('script')
  const [transcriptionIsFinal, setTranscriptionIsFinal] = useState(true)
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const containerRef = useRef(null)

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
      {lineSource === 'transcription' && displayEnabled && (
        <div className="viewer-live-badge">
          {transcriptionIsFinal ? '即時語音 最終稿' : '即時語音 草稿'}
        </div>
      )}
      <div className={textClass}>{displayText}</div>
    </div>
  )
}

export default ViewerPage
