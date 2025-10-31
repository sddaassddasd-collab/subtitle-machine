import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { io } from 'socket.io-client'

const DEFAULT_SESSION_ID = 'default'

const ViewerPage = () => {
  const location = useLocation()
  const query = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  )
  const sessionId = query.get('session') || DEFAULT_SESSION_ID

  const [line, setLine] = useState(null)
  const [displayEnabled, setDisplayEnabled] = useState(true)
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
          const enabled =
            typeof data.displayEnabled === 'boolean'
              ? data.displayEnabled
              : true
          setDisplayEnabled(enabled)
          if (data.line) {
            setLine({
              text: data.line.text || '',
              type:
                data.line.type === 'direction' ? 'direction' : 'dialogue',
            })
          } else if (typeof data.text === 'string') {
            setLine({ text: data.text, type: 'dialogue' })
          } else {
            setLine(null)
          }
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
      const enabled =
        typeof payload.displayEnabled === 'boolean'
          ? payload.displayEnabled
          : true
      setDisplayEnabled(enabled)
      if (payload.line) {
        setLine({
          text: payload.line.text || '',
          type:
            payload.line.type === 'direction' ? 'direction' : 'dialogue',
        })
      } else {
        setLine(null)
      }
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
  }${isStageDirection ? ' viewer-direction' : ''}`
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
      <div className={textClass}>{displayText}</div>
    </div>
  )
}

export default ViewerPage
