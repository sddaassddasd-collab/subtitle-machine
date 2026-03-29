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

const PUBLIC_STATE_REFRESH_INTERVAL_MS = 15000
const PUBLIC_RECOVERY_RETRY_DELAY_MS = 1200

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
  const [, setMusicActive] = useState(false)
  const [, setMusicText] = useState('此處有音樂')
  const [displayEnabled, setDisplayEnabled] = useState(true)
  const [lineSource, setLineSource] = useState('script')
  const [languages, setLanguages] = useState([])
  const [projectorLanguageId, setProjectorLanguageId] = useState('primary')
  const [layout, setLayout] = useState(DEFAULT_PROJECTOR_LAYOUT)
  const [roleColorEnabled, setRoleColorEnabled] = useState(true)
  const [, setFatalError] = useState('')
  const [, setConnectionIssue] = useState('')
  const [, setHasLoadedState] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const containerRef = useRef(null)
  const layoutRevisionRef = useRef(0)
  const hasLoadedStateRef = useRef(false)
  const recoveryTimerRef = useRef(null)

  const clearRecoveryTimer = useCallback(() => {
    if (!recoveryTimerRef.current) return
    window.clearTimeout(recoveryTimerRef.current)
    recoveryTimerRef.current = null
  }, [])

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
      hasLoadedStateRef.current = true
      setHasLoadedState(true)
      setConnectionIssue('')
      setFatalError('')
    },
    [applyProjectorLayoutPayload],
  )

  const classifyPublicFailure = useCallback((response, data, fallbackMessage) => {
    const reason =
      typeof data?.reason === 'string' && data.reason.trim().length > 0
        ? data.reason.trim()
        : ''
    const message =
      data?.error || data?.message || fallbackMessage || '無法載入投影字幕'
    const isTerminalReason = reason === 'ended' || reason === 'deleted'
    const fatal =
      isTerminalReason ||
      (response?.status === 410 && !hasLoadedStateRef.current)

    return { fatal, message, reason }
  }, [])

  useEffect(() => {
    if (!resolvedProjectorToken) {
      setFatalError('缺少投影端連結')
      return
    }

    let cancelled = false
    const fetchProjectorState = async () => {
      try {
        const response = await fetch(`/api/projector/${resolvedProjectorToken}`)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const failure = classifyPublicFailure(
            response,
            data,
            '無法載入投影字幕',
          )
          if (cancelled) return
          if (failure.fatal) {
            setFatalError(failure.message)
          } else {
            setConnectionIssue(failure.message)
          }
          return
        }
        if (!cancelled) {
          applyProjectorDisplayPayload(data)
        }
      } catch (fetchError) {
        if (!cancelled) {
          setConnectionIssue(fetchError.message || '無法載入投影字幕')
        }
      }
    }

    void fetchProjectorState()
    const intervalId = window.setInterval(() => {
      void fetchProjectorState()
    }, PUBLIC_STATE_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearRecoveryTimer()
      window.clearInterval(intervalId)
    }
  }, [
    applyProjectorDisplayPayload,
    classifyPublicFailure,
    clearRecoveryTimer,
    resolvedProjectorToken,
  ])

  useEffect(() => {
    if (!resolvedProjectorToken) return

    const socket = io()
    const joinProjectorSession = () => {
      socket.emit('join', {
        projectorToken: resolvedProjectorToken,
        role: 'projector',
      })
    }

    const fetchProjectorState = async () => {
      try {
        const response = await fetch(`/api/projector/${resolvedProjectorToken}`)
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          const failure = classifyPublicFailure(
            response,
            data,
            '無法載入投影字幕',
          )
          if (failure.fatal) {
            setFatalError(failure.message)
          } else {
            setConnectionIssue(failure.message)
          }
          return
        }
        applyProjectorDisplayPayload(data)
      } catch (error) {
        setConnectionIssue(error.message || '與伺服器重新同步失敗')
      }
    }

    const scheduleRecoveryFetch = () => {
      clearRecoveryTimer()
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null
        void fetchProjectorState()
      }, PUBLIC_RECOVERY_RETRY_DELAY_MS)
    }

    socket.on('connect', () => {
      joinProjectorSession()
      void fetchProjectorState()
    })

    socket.on('disconnect', () => {
      if (hasLoadedStateRef.current) {
        setConnectionIssue('與伺服器連線中斷，正在重新連線')
      }
    })

    socket.on('projector:update', (payload) => {
      applyProjectorDisplayPayload(payload)
    })

    socket.on('projector:layout', (payload) => {
      applyProjectorLayoutPayload(payload?.layout, payload?.revision)
    })

    socket.on('projector:expired', (payload) => {
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
  }, [
    applyProjectorDisplayPayload,
    applyProjectorLayoutPayload,
    classifyPublicFailure,
    clearRecoveryTimer,
    resolvedProjectorToken,
  ])

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

  const toggleFullscreen = useCallback(() => {
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
  }, [])

  useEffect(() => {
    const handleKeyDown = (event) => {
      const activeElement = document.activeElement
      const editingField =
        activeElement &&
        (activeElement.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName))

      if (
        editingField ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return
      }

      if (event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      toggleFullscreen()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleFullscreen])

  const resolvedLayout = normalizeProjectorLayout(layout)
  const projectorStyle = {
    '--projector-font-scale': Math.max(resolvedLayout.fontSizePercent, 0) / 100,
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
        className="projector-fullscreen-hotspot"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      />

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
