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
  const socketRef = useRef(null)
  const layoutRevisionRef = useRef(0)
  const hasLoadedStateRef = useRef(false)
  const recoveryTimerRef = useRef(null)
  const pendingStatusReportsRef = useRef([])
  const lastStatusReportKeyRef = useRef('')

  const clearRecoveryTimer = useCallback(() => {
    if (!recoveryTimerRef.current) return
    window.clearTimeout(recoveryTimerRef.current)
    recoveryTimerRef.current = null
  }, [])

  const flushQueuedStatusReports = useCallback(() => {
    const socket = socketRef.current
    if (!socket?.connected || pendingStatusReportsRef.current.length === 0) {
      return
    }

    const queuedReports = [...pendingStatusReportsRef.current]
    pendingStatusReportsRef.current = []
    queuedReports.forEach((report) => {
      socket.emit('projector:status', report)
    })
  }, [])

  const reportProjectorStatus = useCallback((rawReport) => {
    const level =
      rawReport?.level === 'error'
        ? 'error'
        : rawReport?.level === 'warning'
          ? 'warning'
          : 'info'
    const code =
      typeof rawReport?.code === 'string' ? rawReport.code.trim() : ''
    const message =
      typeof rawReport?.message === 'string' ? rawReport.message.trim() : ''

    if (!code && !message) return

    const report = {
      level,
      code: code || `projector-${level}`,
      message: message || code || '投影端狀態更新',
      occurredAt: Date.now(),
    }
    const reportKey = `${report.level}:${report.code}:${report.message}`
    if (lastStatusReportKeyRef.current === reportKey) {
      return
    }
    lastStatusReportKeyRef.current = reportKey

    const socket = socketRef.current
    if (socket?.connected) {
      socket.emit('projector:status', report)
      return
    }

    pendingStatusReportsRef.current = [
      ...pendingStatusReportsRef.current.slice(-4),
      report,
    ]
  }, [])

  const markProjectorRecovered = useCallback(() => {
    if (
      lastStatusReportKeyRef.current.startsWith('warning:') ||
      lastStatusReportKeyRef.current.startsWith('error:')
    ) {
      reportProjectorStatus({
        level: 'info',
        code: 'recovered',
        message: '投影端已恢復正常',
      })
    }
  }, [reportProjectorStatus])

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
          reportProjectorStatus({
            level: failure.fatal ? 'error' : 'warning',
            code: failure.reason || 'fetch_failed',
            message: failure.message,
          })
          if (failure.fatal) {
            setFatalError(failure.message)
          } else {
            setConnectionIssue(failure.message)
          }
          return
        }
        if (!cancelled) {
          applyProjectorDisplayPayload(data)
          markProjectorRecovered()
        }
      } catch (fetchError) {
        if (!cancelled) {
          reportProjectorStatus({
            level: 'warning',
            code: 'fetch_failed',
            message: fetchError.message || '無法載入投影字幕',
          })
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
    markProjectorRecovered,
    reportProjectorStatus,
    resolvedProjectorToken,
  ])

  useEffect(() => {
    if (!resolvedProjectorToken) return

    const socket = io()
    socketRef.current = socket
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
          reportProjectorStatus({
            level: failure.fatal ? 'error' : 'warning',
            code: failure.reason || 'fetch_failed',
            message: failure.message,
          })
          if (failure.fatal) {
            setFatalError(failure.message)
          } else {
            setConnectionIssue(failure.message)
          }
          return
        }
        applyProjectorDisplayPayload(data)
        markProjectorRecovered()
      } catch (error) {
        reportProjectorStatus({
          level: 'warning',
          code: 'fetch_failed',
          message: error.message || '與伺服器重新同步失敗',
        })
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
      flushQueuedStatusReports()
      void fetchProjectorState()
    })

    socket.on('disconnect', () => {
      if (hasLoadedStateRef.current) {
        reportProjectorStatus({
          level: 'warning',
          code: 'socket_disconnect',
          message: '投影端與伺服器連線中斷',
        })
        setConnectionIssue('與伺服器連線中斷，正在重新連線')
        scheduleRecoveryFetch()
      }
    })

    socket.on('projector:update', (payload) => {
      applyProjectorDisplayPayload(payload)
      markProjectorRecovered()
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
      reportProjectorStatus({
        level: 'error',
        code: reason || 'expired',
        message,
      })

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
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [
    applyProjectorDisplayPayload,
    applyProjectorLayoutPayload,
    classifyPublicFailure,
    clearRecoveryTimer,
    flushQueuedStatusReports,
    markProjectorRecovered,
    reportProjectorStatus,
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
      requestFullscreen(container).catch((error) => {
        reportProjectorStatus({
          level: 'warning',
          code: 'fullscreen_enter_failed',
          message: error?.message || '無法進入全螢幕',
        })
      })
    } else {
      exitFullscreen().catch((error) => {
        reportProjectorStatus({
          level: 'warning',
          code: 'fullscreen_exit_failed',
          message: error?.message || '無法離開全螢幕',
        })
      })
    }
  }, [reportProjectorStatus])

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

  useEffect(() => {
    const handleRuntimeError = (event) => {
      reportProjectorStatus({
        level: 'error',
        code: 'runtime_error',
        message: event?.message || '投影端發生未預期錯誤',
      })
    }

    const handleUnhandledRejection = (event) => {
      const reason = event?.reason
      reportProjectorStatus({
        level: 'error',
        code: 'unhandled_rejection',
        message:
          typeof reason === 'string'
            ? reason
            : reason?.message || '投影端發生未處理的 Promise 錯誤',
      })
    }

    window.addEventListener('error', handleRuntimeError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    return () => {
      window.removeEventListener('error', handleRuntimeError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [reportProjectorStatus])

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
