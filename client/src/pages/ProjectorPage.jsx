import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { io } from 'socket.io-client'
import {
  DEFAULT_PROJECTOR_LAYOUT,
  normalizeDisplayPayload,
  normalizeProjectorLayout,
  normalizeProjectorRevision,
  resolveAvailableLanguageId,
  resolveLineText,
  roleToColor,
} from '../lib/displayPayload'

const ProjectorPage = () => {
  const { projectorToken } = useParams()
  const location = useLocation()
  const query = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  )
  const resolvedProjectorToken = projectorToken || query.get('projector') || ''

  const [line, setLine] = useState(null)
  const [liveEntries, setLiveEntries] = useState([])
  const [liveLines, setLiveLines] = useState([])
  const [musicActive, setMusicActive] = useState(false)
  const [musicText, setMusicText] = useState('此處有音樂')
  const [displayEnabled, setDisplayEnabled] = useState(true)
  const [lineSource, setLineSource] = useState('script')
  const [languages, setLanguages] = useState([])
  const [projectorLanguageId, setProjectorLanguageId] = useState('primary')
  const [layout, setLayout] = useState(DEFAULT_PROJECTOR_LAYOUT)
  const [roleColorEnabled, setRoleColorEnabled] = useState(true)
  const [error, setError] = useState('')
  const [isFullscreen, setIsFullscreen] = useState(false)
  const containerRef = useRef(null)
  const layoutRevisionRef = useRef(0)

  const applyProjectorLayoutPayload = useCallback((rawLayout, rawRevision) => {
    const nextRevision = normalizeProjectorRevision(rawRevision)
    if (nextRevision < layoutRevisionRef.current) return
    layoutRevisionRef.current = nextRevision
    setLayout(normalizeProjectorLayout(rawLayout))
  }, [])

  const applyProjectorDisplayPayload = useCallback(
    (payload) => {
      const next = normalizeDisplayPayload(payload)
      setDisplayEnabled(next.enabled)
      setLine(next.line)
      setLiveEntries(next.liveEntries)
      setLiveLines(next.liveLines)
      setMusicActive(next.musicActive)
      setMusicText(next.musicText)
      setLineSource(next.source)
      setLanguages(next.languages)
      setProjectorLanguageId(
        resolveAvailableLanguageId(next.languages, next.defaultLanguageId),
      )
      applyProjectorLayoutPayload(next.layout, next.revision)
      setRoleColorEnabled(next.roleColorEnabled)
    },
    [applyProjectorLayoutPayload],
  )

  useEffect(() => {
    if (!resolvedProjectorToken) {
      setError('缺少投影端連結')
      return
    }

    let cancelled = false
    const fetchInitialState = async () => {
      try {
        const response = await fetch(`/api/projector/${resolvedProjectorToken}`)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(
            data?.error || data?.message || '無法載入投影字幕',
          )
        }
        if (!cancelled) {
          applyProjectorDisplayPayload(data)
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError.message || '無法載入投影字幕')
        }
      }
    }

    fetchInitialState()
    return () => {
      cancelled = true
    }
  }, [applyProjectorDisplayPayload, resolvedProjectorToken])

  useEffect(() => {
    if (!resolvedProjectorToken) return

    const socket = io()
    socket.emit('join', {
      projectorToken: resolvedProjectorToken,
      role: 'projector',
    })

    socket.on('projector:update', (payload) => {
      applyProjectorDisplayPayload(payload)
      setError('')
    })

    socket.on('projector:layout', (payload) => {
      applyProjectorLayoutPayload(payload?.layout, payload?.revision)
    })

    socket.on('projector:expired', (payload) => {
      setError(
        typeof payload?.message === 'string'
          ? payload.message
          : '本場次已結束',
      )
    })

    return () => {
      socket.disconnect()
    }
  }, [applyProjectorDisplayPayload, applyProjectorLayoutPayload, resolvedProjectorToken])

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

  if (error) {
    return (
      <div className="projector-page">
        <div className="no-session">
          <h2>無法載入投影字幕</h2>
          <p>{error}</p>
        </div>
      </div>
    )
  }

  const resolvedLayout = normalizeProjectorLayout(layout)
  const projectorStyle = {
    '--projector-font-scale': resolvedLayout.fontSizePercent / 100,
    '--projector-offset-x': `${resolvedLayout.offsetX}vw`,
    '--projector-offset-y': `${resolvedLayout.offsetY}vh`,
  }
  const shouldRenderLiveFeed = displayEnabled && lineSource === 'transcription'
  const shouldRenderScriptText =
    displayEnabled &&
    lineSource !== 'transcription' &&
    line &&
    line.type !== 'direction'
  const scriptText = shouldRenderScriptText
    ? resolveLineText(
        line,
        resolveAvailableLanguageId(languages, projectorLanguageId),
      ) || ''
    : ''
  const scriptTextColor =
    roleColorEnabled && shouldRenderScriptText ? roleToColor(line?.role) : ''
  const entries =
    liveEntries.length > 0
      ? liveEntries
      : liveLines.map((text) => ({
          text,
          speakerId: null,
          isFinal: true,
        }))

  return (
    <div className="projector-page" ref={containerRef} style={projectorStyle}>
      <button
        type="button"
        className="fullscreen-button projector-fullscreen-button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      >
        ⛶
      </button>

      {displayEnabled && musicActive && (
        <div className="viewer-music-banner projector-music-banner" role="status" aria-live="polite">
          <div className="viewer-music-banner-inner">
            <span className="viewer-music-label">音樂提示</span>
            <span className="viewer-music-text">{musicText}</span>
          </div>
        </div>
      )}

      <div className="projector-stage">
        <div className="projector-subtitle-block">
          {shouldRenderLiveFeed ? (
            <div className="projector-live-feed">
              {entries.map((entry, index) => {
                const isLatest = index === entries.length - 1
                return (
                  <div
                    key={`${index}-${entry.text}`}
                    className={`projector-live-line${
                      isLatest ? ' projector-live-line-active' : ''
                    }${entry.isFinal && isLatest ? ' projector-live-line-final' : ''}`}
                  >
                    {entry.text}
                  </div>
                )
              })}
            </div>
          ) : (
            <div
              className="projector-text"
              style={scriptTextColor ? { color: scriptTextColor } : undefined}
            >
              {scriptText}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ProjectorPage
