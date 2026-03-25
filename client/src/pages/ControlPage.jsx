import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { io } from 'socket.io-client'
import {
  normalizeProjectorLayout,
  resolveLineText,
  roleToColor,
} from '../lib/displayPayload'

const storageKeys = {
  apiKey: 'subtitleMachineApiKey',
  rememberKey: 'subtitleMachineRememberKey',
}

const DEFAULT_TRANSCRIPTION_MODEL = 'gpt-4o-transcribe'
const ALLOWED_TRANSCRIPTION_MODELS = new Set([
  'gpt-4o-transcribe',
  'gpt-4o-transcribe-latest',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe-diarize',
  'whisper-1',
])

const DEFAULT_TRANSCRIPTION_STATE = {
  active: false,
  status: 'idle',
  text: '',
  isFinal: true,
  language: null,
  model: DEFAULT_TRANSCRIPTION_MODEL,
  transcriptionContext: '',
  semanticSegmentationEnabled: true,
  dualChannelEnabled: true,
  speakerRecognitionEnabled: false,
  error: '',
  updatedAt: null,
}

const TARGET_SAMPLE_RATE = 24000
const MIC_CAPTURE_WORKLET_URL = new URL(
  '../worklets/mic-capture-processor.js',
  import.meta.url,
)

const normalizeTranscriptionState = (raw) => {
  if (!raw || typeof raw !== 'object') {
    return DEFAULT_TRANSCRIPTION_STATE
  }

  return {
    ...DEFAULT_TRANSCRIPTION_STATE,
    ...raw,
    active: Boolean(raw.active),
    text: typeof raw.text === 'string' ? raw.text : '',
    isFinal: raw.isFinal !== false,
    error: typeof raw.error === 'string' ? raw.error : '',
    status:
      typeof raw.status === 'string' && raw.status.trim().length > 0
        ? raw.status
        : 'idle',
    model:
      typeof raw.model === 'string' &&
      ALLOWED_TRANSCRIPTION_MODELS.has(raw.model.trim())
        ? raw.model.trim()
        : DEFAULT_TRANSCRIPTION_MODEL,
    language:
      typeof raw.language === 'string' && raw.language.trim().length > 0
        ? raw.language
        : null,
    transcriptionContext:
      typeof raw.transcriptionContext === 'string'
        ? raw.transcriptionContext
        : '',
    semanticSegmentationEnabled: raw.semanticSegmentationEnabled !== false,
    dualChannelEnabled: raw.dualChannelEnabled !== false,
    speakerRecognitionEnabled: raw.speakerRecognitionEnabled === true,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : null,
  }
}

const mixChannelsToMono = (channels) => {
  if (!Array.isArray(channels) || channels.length === 0) {
    return new Float32Array(0)
  }

  const firstChannel = channels.find(
    (channel) => channel && typeof channel.length === 'number' && channel.length > 0,
  )
  if (!firstChannel) {
    return new Float32Array(0)
  }

  const frameCount = firstChannel.length
  const output = new Float32Array(frameCount)
  let activeChannels = 0

  channels.forEach((channel) => {
    if (!channel || channel.length !== frameCount) return
    activeChannels += 1
    for (let index = 0; index < frameCount; index += 1) {
      output[index] += channel[index]
    }
  })

  if (activeChannels <= 1) {
    return activeChannels === 1 ? output : new Float32Array(0)
  }

  for (let index = 0; index < frameCount; index += 1) {
    output[index] /= activeChannels
  }

  return output
}

const downsampleFloat32 = (input, inputSampleRate, outputSampleRate) => {
  if (!input?.length) {
    return new Float32Array(0)
  }

  if (
    !Number.isFinite(inputSampleRate) ||
    inputSampleRate <= 0 ||
    inputSampleRate === outputSampleRate
  ) {
    return input
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate
  const outputLength = Math.max(Math.floor(input.length / sampleRateRatio), 0)
  const output = new Float32Array(outputLength)

  let outputIndex = 0
  let inputIndex = 0

  while (outputIndex < output.length) {
    const nextInputIndex = Math.min(
      Math.round((outputIndex + 1) * sampleRateRatio),
      input.length,
    )

    let sum = 0
    let count = 0
    for (let index = inputIndex; index < nextInputIndex; index += 1) {
      sum += input[index]
      count += 1
    }

    output[outputIndex] = count > 0 ? sum / count : 0
    outputIndex += 1
    inputIndex = nextInputIndex
  }

  return output
}

const computeSignalLevel = (input) => {
  if (!input?.length) {
    return 0
  }

  let sumSquares = 0
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index]
    sumSquares += sample * sample
  }

  return Math.min(1, Math.sqrt(sumSquares / input.length))
}

const float32ToInt16 = (input) => {
  const output = new Int16Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output
}

const int16ToBase64 = (samples) => {
  if (!samples || samples.length === 0) return ''

  const bytes = new Uint8Array(samples.buffer)
  const chunkSize = 0x8000
  let binary = ''

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

const isLineMarkedMusic = (line) =>
  Boolean(line && typeof line === 'object' && line.music === true)

const applyLineMusicState = (sourceLines, index, music) =>
  sourceLines.map((line, lineIndex) => {
    if (lineIndex !== index) return line
    if (line && typeof line === 'object') {
      return { ...line, music }
    }
    return {
      text: typeof line === 'string' ? line : '',
      type: 'dialogue',
      music,
    }
  })

const applyMusicRangeState = (sourceLines, startIndex, endIndex, music) => {
  const rangeStart = Math.min(startIndex, endIndex)
  const rangeEnd = Math.max(startIndex, endIndex)
  return sourceLines.map((line, index) => {
    if (index < rangeStart || index > rangeEnd) return line
    if (line && typeof line === 'object') {
      return { ...line, music }
    }
    return {
      text: typeof line === 'string' ? line : '',
      type: 'dialogue',
      music,
    }
  })
}

const getMusicRangeAroundIndex = (sourceLines, index) => {
  if (!Array.isArray(sourceLines) || index < 0 || index >= sourceLines.length) {
    return null
  }
  if (!isLineMarkedMusic(sourceLines[index])) return null

  let startIndex = index
  let endIndex = index

  while (
    startIndex > 0 &&
    isLineMarkedMusic(sourceLines[startIndex - 1])
  ) {
    startIndex -= 1
  }

  while (
    endIndex < sourceLines.length - 1 &&
    isLineMarkedMusic(sourceLines[endIndex + 1])
  ) {
    endIndex += 1
  }

  return { startIndex, endIndex }
}

const ControlPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const query = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  )
  const requestedSessionId = query.get('session') || ''

  const [user, setUser] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [sessionId, setSessionId] = useState(requestedSessionId)
  const [sessionMeta, setSessionMeta] = useState(null)
  const [lines, setLines] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [displayEnabled, setDisplayEnabled] = useState(true)
  const [roleColorEnabled, setRoleColorEnabled] = useState(true)
  const [projectorLayout, setProjectorLayout] = useState(() =>
    normalizeProjectorLayout(),
  )
  const [historyState, setHistoryState] = useState({
    canUndo: false,
    canRedo: false,
  })
  const [transcription, setTranscription] = useState(
    DEFAULT_TRANSCRIPTION_STATE,
  )
  const [status, setStatus] = useState({ kind: 'info', message: '' })
  const [apiKey, setApiKey] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(storageKeys.apiKey) || ''
  })
  const [rememberKey, setRememberKey] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(storageKeys.rememberKey) === 'true'
  })
  const [draftInputs, setDraftInputs] = useState({})
  const [parsingPrimary, setParsingPrimary] = useState(false)
  const [parsingLanguageId, setParsingLanguageId] = useState('')
  const [editingIndex, setEditingIndex] = useState(null)
  const [pendingMusicRangeStartIndex, setPendingMusicRangeStartIndex] =
    useState(null)
  const [autoCenterEnabled, setAutoCenterEnabled] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [qrCodeUrl, setQrCodeUrl] = useState('')
  const socketRef = useRef(null)
  const jsonInputRef = useRef(null)
  const lineRefs = useRef([])
  const pendingLineClickTimeoutRef = useRef(null)
  const skipBlurRef = useRef(new Set())
  const lastTranscriptionErrorRef = useRef('')
  const captureStateRef = useRef({
    mediaStream: null,
    audioContext: null,
    sourceNode: null,
    captureNode: null,
    silenceNode: null,
  })

  const languages = useMemo(() => {
    const source = Array.isArray(sessionMeta?.languages)
      ? sessionMeta.languages
      : []
    if (source.length > 0) return source
    return [
      {
        id: 'primary',
        name: '第一語言',
        code: 'lang-1',
        isPrimary: true,
      },
    ]
  }, [sessionMeta])

  const cells = useMemo(
    () => (Array.isArray(sessionMeta?.cells) ? sessionMeta.cells : []),
    [sessionMeta],
  )
  const selectedCellId = sessionMeta?.selectedCellId || cells[0]?.id || ''
  const selectedCell =
    cells.find((cell) => cell.id === selectedCellId) || null
  const extraLanguages = languages.filter((language) => language.id !== 'primary')
  const viewerDefaultLanguageId =
    sessionMeta?.viewerDefaultLanguageId || languages[0]?.id || 'primary'
  const projectorDefaultLanguageId =
    sessionMeta?.projectorDefaultLanguageId || languages[0]?.id || 'primary'

  const setDraftInputValue = (cellId, languageId, value) => {
    if (!cellId || !languageId) return
    setDraftInputs((prev) => ({
      ...prev,
      [cellId]: {
        ...(prev[cellId] || {}),
        [languageId]: value,
      },
    }))
  }

  const getDraftInputValue = (cellId, languageId) => {
    if (!cellId || !languageId) return ''
    return draftInputs[cellId]?.[languageId] || ''
  }

  const primaryScriptInput = getDraftInputValue(selectedCellId, 'primary')

  const viewerUrl = useMemo(() => {
    if (typeof window === 'undefined' || !sessionMeta?.viewerToken) return ''
    return `${window.location.origin}/viewer/${sessionMeta.viewerToken}`
  }, [sessionMeta?.viewerToken])

  const projectorUrl = useMemo(() => {
    if (typeof window === 'undefined' || !sessionMeta?.projectorToken) return ''
    return `${window.location.origin}/projector/${sessionMeta.projectorToken}`
  }, [sessionMeta?.projectorToken])

  useEffect(() => {
    let cancelled = false

    const generateQrCode = async () => {
      if (!viewerUrl) {
        setQrCodeUrl('')
        return
      }

      try {
        const nextQrCodeUrl = await QRCode.toDataURL(viewerUrl, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 512,
        })
        if (!cancelled) {
          setQrCodeUrl(nextQrCodeUrl)
        }
      } catch {
        if (!cancelled) {
          setQrCodeUrl('')
        }
      }
    }

    generateQrCode()
    return () => {
      cancelled = true
    }
  }, [viewerUrl])

  const applySessionPayload = useCallback((payload) => {
    const nextSession =
      payload && typeof payload.session === 'object' ? payload.session : null
    setSessionMeta(nextSession)
    setLines(Array.isArray(payload?.lines) ? payload.lines : [])
    setCurrentIndex(
      Number.isInteger(payload?.currentIndex) ? payload.currentIndex : 0,
    )
    setDisplayEnabled(
      typeof payload?.displayEnabled === 'boolean'
        ? payload.displayEnabled
        : true,
    )
    setRoleColorEnabled(payload?.roleColorEnabled !== false)
    setProjectorLayout(normalizeProjectorLayout(payload?.projector?.layout))
    setTranscription(normalizeTranscriptionState(payload?.transcription))
    setHistoryState({
      canUndo: payload?.history?.canUndo === true,
      canRedo: payload?.history?.canRedo === true,
    })
  }, [])

  const releaseMicrophoneCapture = () => {
    const state = captureStateRef.current
    if (!state) return

    const {
      captureNode,
      sourceNode,
      silenceNode,
      audioContext,
      mediaStream,
    } = state

    if (captureNode) {
      try {
        if ('onaudioprocess' in captureNode) {
          captureNode.onaudioprocess = null
        }
        if ('port' in captureNode && captureNode.port) {
          captureNode.port.onmessage = null
        }
        captureNode.disconnect()
      } catch {
        // Ignore cleanup errors.
      }
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect()
      } catch {
        // Ignore cleanup errors.
      }
    }
    if (silenceNode) {
      try {
        silenceNode.disconnect()
      } catch {
        // Ignore cleanup errors.
      }
    }
    if (audioContext) {
      audioContext.close().catch(() => {})
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => {
        try {
          track.stop()
        } catch {
          // Ignore cleanup errors.
        }
      })
    }

    captureStateRef.current = {
      mediaStream: null,
      audioContext: null,
      sourceNode: null,
      captureNode: null,
      silenceNode: null,
    }
  }

  const clearPendingLineClick = useCallback(() => {
    if (!pendingLineClickTimeoutRef.current) return
    window.clearTimeout(pendingLineClickTimeoutRef.current)
    pendingLineClickTimeoutRef.current = null
  }, [])

  const queueLineSelection = useCallback(
    (index) => {
      clearPendingLineClick()
      pendingLineClickTimeoutRef.current = window.setTimeout(() => {
        pendingLineClickTimeoutRef.current = null
        if (!socketRef.current || !sessionId) return
        setEditingIndex(null)
        socketRef.current.emit('setCurrentIndex', { sessionId, index })
        setCurrentIndex(index)
      }, 180)
    },
    [clearPendingLineClick, sessionId],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(
      storageKeys.rememberKey,
      rememberKey ? 'true' : 'false',
    )

    if (rememberKey && apiKey) {
      window.localStorage.setItem(storageKeys.apiKey, apiKey)
    }

    if (!rememberKey) {
      window.localStorage.removeItem(storageKeys.apiKey)
    }
  }, [rememberKey, apiKey])

  useEffect(() => {
    let cancelled = false

    const loadAuth = async () => {
      try {
        const response = await fetch('/api/auth/me')
        const data = await response.json().catch(() => ({}))
        if (cancelled) return
        if (!data?.user) {
          navigate('/', { replace: true })
          return
        }
        setUser(data.user)
      } catch {
        if (!cancelled) {
          navigate('/', { replace: true })
        }
      } finally {
        if (!cancelled) {
          setAuthReady(true)
        }
      }
    }

    loadAuth()
    return () => {
      cancelled = true
    }
  }, [navigate])

  useEffect(() => {
    setSessionId(requestedSessionId)
  }, [requestedSessionId])

  useEffect(() => {
    if (!authReady || !user) return
    if (!requestedSessionId) {
      navigate('/', { replace: true })
    }
  }, [authReady, user, requestedSessionId, navigate])

  useEffect(() => {
    if (editingIndex == null) return
    const node = lineRefs.current[editingIndex]
    if (!node) return

    requestAnimationFrame(() => {
      node.focus()
      const range = document.createRange()
      range.selectNodeContents(node)
      range.collapse(false)
      const selection = window.getSelection()
      if (selection) {
        selection.removeAllRanges()
        selection.addRange(range)
      }
    })
  }, [editingIndex, lines])

  useEffect(() => {
    if (editingIndex != null && editingIndex >= lines.length) {
      setEditingIndex(null)
    }
  }, [lines, editingIndex])

  useEffect(() => {
    if (
      pendingMusicRangeStartIndex != null &&
      (pendingMusicRangeStartIndex < 0 ||
        pendingMusicRangeStartIndex >= lines.length)
    ) {
      setPendingMusicRangeStartIndex(null)
    }
  }, [lines, pendingMusicRangeStartIndex])

  useEffect(() => {
    if (editingIndex != null) return
    const node = lineRefs.current[currentIndex]
    if (!node) return

    if (!autoCenterEnabled) {
      if (currentIndex === 0) return
      setAutoCenterEnabled(true)
    }

    node.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: autoCenterEnabled ? 'smooth' : 'auto',
    })
  }, [currentIndex, lines, autoCenterEnabled, editingIndex])

  useEffect(() => {
    if (!authReady || !user || !sessionId) return

    let disposed = false
    const socket = io()
    socketRef.current = socket

    const joinSession = () => {
      if (disposed || !sessionId) return
      socket.emit('join', { sessionId, role: 'control' })
    }

    const refreshSession = async () => {
      try {
        const response = await fetch(`/api/session/${sessionId}`)
        if (!response.ok) {
          throw new Error('找不到場次或無法載入資料')
        }
        const data = await response.json()
        if (disposed) return
        applySessionPayload(data)
      } catch (error) {
        if (!disposed) {
          setStatus({
            kind: 'error',
            message: error?.message || '找不到場次或無法載入資料',
          })
        }
      }
    }

    const rejoinAndRefresh = () => {
      joinSession()
      refreshSession()
    }

    const handleTranscriptionUpdate = (payload) => {
      setTranscription(normalizeTranscriptionState(payload?.transcription))
    }

    const handleTranscriptionError = (payload) => {
      const message =
        payload && typeof payload.message === 'string'
          ? payload.message
          : '即時語音辨識發生錯誤'
      setStatus({ kind: 'error', message })
    }

    socket.on('connect', rejoinAndRefresh)
    socket.on('reconnect', rejoinAndRefresh)
    socket.on('control:update', applySessionPayload)
    socket.on('control:transcription', handleTranscriptionUpdate)
    socket.on('transcription:error', handleTranscriptionError)

    if (socket.connected) {
      rejoinAndRefresh()
    } else {
      refreshSession()
    }

    return () => {
      disposed = true
      releaseMicrophoneCapture()
      if (sessionId) {
        socket.emit('transcription:stop', { sessionId })
      }
      socket.disconnect()
      socketRef.current = null
    }
  }, [authReady, user, sessionId, applySessionPayload])

  useEffect(() => {
    return () => {
      clearPendingLineClick()
      releaseMicrophoneCapture()
    }
  }, [clearPendingLineClick])

  useEffect(() => {
    if (transcription.active || transcription.status === 'connecting') {
      return
    }

    const state = captureStateRef.current
    if (state?.mediaStream || state?.audioContext || state?.captureNode) {
      releaseMicrophoneCapture()
    }
  }, [transcription.active, transcription.status])

  useEffect(() => {
    if (!transcription.error) {
      lastTranscriptionErrorRef.current = ''
      return
    }

    if (lastTranscriptionErrorRef.current === transcription.error) {
      return
    }

    lastTranscriptionErrorRef.current = transcription.error
    setStatus({
      kind: 'error',
      message: `即時語音辨識：${transcription.error}`,
    })
  }, [transcription.error])

  const requestSessionRefresh = async () => {
    if (!sessionId) return
    const response = await fetch(`/api/session/${sessionId}`)
    if (!response.ok) {
      throw new Error('無法重新載入場次')
    }
    const data = await response.json()
    applySessionPayload(data)
  }

  const performSessionMutation = async (
    request,
    { successMessage = '', keepStatus = false } = {},
  ) => {
    try {
      const response = await request()
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '操作失敗')
      }
      if (data && typeof data === 'object' && data.session) {
        applySessionPayload(data)
      } else if (sessionId) {
        await requestSessionRefresh()
      }
      if (!keepStatus) {
        setStatus({
          kind: 'success',
          message: successMessage || '已完成操作',
        })
      }
      return data
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error.message || '操作失敗',
      })
      throw error
    }
  }

  const handleToggleDisplay = () => {
    if (!socketRef.current || !sessionId) return
    const nextState = !displayEnabled
    socketRef.current.emit('setDisplay', {
      sessionId,
      displayEnabled: nextState,
    })
    setDisplayEnabled(nextState)
    setStatus({
      kind: 'info',
      message: nextState ? '外部字幕已重新顯示' : '檢視端與投影端已遮蔽字幕',
    })
  }

  const handleToggleRoleColorEnabled = () => {
    if (!socketRef.current || !sessionId) return
    const nextState = !roleColorEnabled
    socketRef.current.emit('setRoleColorEnabled', {
      sessionId,
      roleColorEnabled: nextState,
    })
    setRoleColorEnabled(nextState)
    setStatus({
      kind: 'info',
      message: nextState
        ? '外部字幕已改為顏色區分角色'
        : '外部字幕已改為單色顯示',
    })
  }

  const handleViewerDefaultLanguageChange = (event) => {
    if (!socketRef.current || !sessionId) return
    const nextLanguageId = event.target.value
    socketRef.current.emit('setViewerDefaultLanguage', {
      sessionId,
      languageId: nextLanguageId,
    })
    setSessionMeta((prev) =>
      prev
        ? {
            ...prev,
            viewerDefaultLanguageId: nextLanguageId,
          }
        : prev,
    )
    setStatus({
      kind: 'info',
      message: '檢視端預設語言已更新',
    })
  }

  const handleProjectorDefaultLanguageChange = (event) => {
    if (!socketRef.current || !sessionId) return
    const nextLanguageId = event.target.value
    socketRef.current.emit('setProjectorDefaultLanguage', {
      sessionId,
      languageId: nextLanguageId,
    })
    setSessionMeta((prev) =>
      prev
        ? {
            ...prev,
            projectorDefaultLanguageId: nextLanguageId,
          }
        : prev,
    )
    setStatus({
      kind: 'info',
      message: '投影端播放語言已更新',
    })
  }

  const handleUndo = async () => {
    if (!sessionId || !historyState.canUndo) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/undo`, {
          method: 'POST',
        }),
      { successMessage: '已復原上一個操作' },
    )
  }

  const handleRedo = async () => {
    if (!sessionId || !historyState.canRedo) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/redo`, {
          method: 'POST',
        }),
      { successMessage: '已還原操作' },
    )
  }

  useEffect(() => {
    if (!sessionId) return

    const runHistoryAction = async (action) => {
      try {
        const response = await fetch(`/api/session/${sessionId}/${action}`, {
          method: 'POST',
        })
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(data.error || '操作失敗')
        }
        if (data?.session) {
          applySessionPayload(data)
        }
      } catch (error) {
        setStatus({
          kind: 'error',
          message: error.message || '操作失敗',
        })
      }
    }

    const handleKeyDown = (event) => {
      const key = event.key.toLowerCase()
      const activeElement = document.activeElement
      const editingField =
        activeElement &&
        (activeElement.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName))

      if (!editingField && (event.metaKey || event.ctrlKey) && key === 'm') {
        event.preventDefault()
        if (!socketRef.current) return
        const nextState = !displayEnabled
        socketRef.current.emit('setDisplay', {
          sessionId,
          displayEnabled: nextState,
        })
        setDisplayEnabled(nextState)
        return
      }

      if (!editingField && (event.metaKey || event.ctrlKey) && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          if (historyState.canRedo) {
            runHistoryAction('redo')
          }
        } else {
          if (historyState.canUndo) {
            runHistoryAction('undo')
          }
        }
        return
      }

      if (!editingField && (event.metaKey || event.ctrlKey) && key === 'y') {
        event.preventDefault()
        if (historyState.canRedo) {
          runHistoryAction('redo')
        }
        return
      }

      if (editingField) return
      if (!socketRef.current) return

      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        socketRef.current.emit('shiftIndex', {
          sessionId,
          delta: event.key === 'ArrowUp' ? -1 : 1,
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [sessionId, displayEnabled, historyState.canUndo, historyState.canRedo, applySessionPayload])

  const handleStartLiveTranscription = async () => {
    if (!socketRef.current || !sessionId) {
      setStatus({ kind: 'error', message: '尚未連上場次，無法啟動語音辨識' })
      return
    }

    if (!apiKey) {
      setStatus({ kind: 'error', message: '請先填入 OpenAI API Key' })
      return
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      setStatus({
        kind: 'error',
        message: '目前瀏覽器不支援麥克風錄音功能',
      })
      return
    }

    if (transcription.active || transcription.status === 'connecting') {
      setStatus({ kind: 'info', message: '語音辨識已啟動' })
      return
    }

    try {
      releaseMicrophoneCapture()
      setStatus({ kind: 'info', message: '正在啟動即時語音辨識…' })
      setTranscription((prev) => ({
        ...prev,
        status: 'connecting',
        active: false,
        text: '',
        isFinal: true,
        error: '',
      }))

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
        },
      })

      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) {
        throw new Error('瀏覽器不支援 AudioContext')
      }

      const audioContext = new AudioContextClass()
      await audioContext.resume()

      const sourceNode = audioContext.createMediaStreamSource(stream)
      const silenceNode = audioContext.createGain()
      silenceNode.gain.value = 0

      const emitSamples = (sourceSamples) => {
        if (!sourceSamples?.length) return
        const socket = socketRef.current
        if (!socket || !sessionId) return

        const downsampled = downsampleFloat32(
          sourceSamples,
          audioContext.sampleRate,
          TARGET_SAMPLE_RATE,
        )
        if (!downsampled.length) return

        const pcm16 = float32ToInt16(downsampled)
        const audio = int16ToBase64(pcm16)
        if (!audio) return
        const durationMs = (pcm16.length / TARGET_SAMPLE_RATE) * 1000
        const level = computeSignalLevel(downsampled)

        socket.emit('transcription:audio', {
          sessionId,
          audio,
          durationMs,
          level,
        })
      }

      let captureNode = null
      const AudioWorkletNodeClass =
        typeof globalThis !== 'undefined'
          ? globalThis.AudioWorkletNode
          : undefined

      if (
        audioContext.audioWorklet &&
        typeof AudioWorkletNodeClass === 'function'
      ) {
        await audioContext.audioWorklet.addModule(MIC_CAPTURE_WORKLET_URL.href)
        const workletNode = new AudioWorkletNodeClass(
          audioContext,
          'mic-capture-processor',
          {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 1,
          },
        )
        workletNode.port.onmessage = (workletEvent) => {
          const sourceSamples = workletEvent.data
          if (sourceSamples instanceof Float32Array) {
            emitSamples(sourceSamples)
          } else if (sourceSamples?.length > 0) {
            emitSamples(Float32Array.from(sourceSamples))
          }
        }
        sourceNode.connect(workletNode)
        workletNode.connect(silenceNode)
        captureNode = workletNode
      } else {
        const processorNode = audioContext.createScriptProcessor(4096, 2, 1)
        processorNode.onaudioprocess = (event) => {
          const channels = []
          for (
            let channelIndex = 0;
            channelIndex < event.inputBuffer.numberOfChannels;
            channelIndex += 1
          ) {
            channels.push(event.inputBuffer.getChannelData(channelIndex))
          }
          emitSamples(mixChannelsToMono(channels))
        }
        sourceNode.connect(processorNode)
        processorNode.connect(silenceNode)
        captureNode = processorNode
      }

      silenceNode.connect(audioContext.destination)
      captureStateRef.current = {
        mediaStream: stream,
        audioContext,
        sourceNode,
        captureNode,
        silenceNode,
      }

      socketRef.current.emit('transcription:start', {
        sessionId,
        apiKey,
        model: transcription.model || DEFAULT_TRANSCRIPTION_MODEL,
        language: transcription.language || 'zh',
        semanticSegmentationEnabled: true,
        dualChannelEnabled: true,
        transcriptionContext: transcription.transcriptionContext || '',
        speakerRecognitionEnabled:
          transcription.speakerRecognitionEnabled === true,
      })
    } catch (error) {
      releaseMicrophoneCapture()
      socketRef.current?.emit('transcription:stop', { sessionId })
      setTranscription((prev) => ({
        ...prev,
        active: false,
        status: 'error',
        error: error?.message || '無法啟動語音辨識',
      }))
      setStatus({
        kind: 'error',
        message: error?.message || '無法啟動語音辨識',
      })
    }
  }

  const handleStopLiveTranscription = () => {
    if (!sessionId) return
    releaseMicrophoneCapture()
    socketRef.current?.emit('transcription:stop', { sessionId })
    setStatus({ kind: 'info', message: '已停止即時語音辨識' })
  }

  const handleJumpToLine = (index) => {
    clearPendingLineClick()
    if (!socketRef.current || !sessionId) return
    setEditingIndex(null)
    socketRef.current.emit('setCurrentIndex', { sessionId, index })
    setCurrentIndex(index)
  }

  const handleLineTextClick = (event, index) => {
    event.stopPropagation()
    if (editingIndex === index) return
    queueLineSelection(index)
  }

  const handleLineTextDoubleClick = (event, index) => {
    event.stopPropagation()
    clearPendingLineClick()
    setEditingIndex(index)
  }

  const handleLineBlur = (event, index) => {
    if (skipBlurRef.current.has(index)) {
      skipBlurRef.current.delete(index)
      return
    }
    if (editingIndex !== index) return
    setEditingIndex(null)
    const newText = event.currentTarget.textContent ?? ''
    const currentLine = lines[index]
    const currentText =
      typeof currentLine === 'object' ? currentLine?.text ?? '' : ''
    if (newText === currentText || !socketRef.current || !sessionId) return

    socketRef.current.emit('updateLine', {
      sessionId,
      index,
      text: newText,
      languageId: 'primary',
    })
    setLines((prev) => {
      const next = [...prev]
      const previous = next[index]
      if (typeof previous === 'object' && previous) {
        next[index] = {
          ...previous,
          text: newText,
          translations: {
            ...(previous.translations || {}),
            primary: newText,
          },
        }
      }
      return next
    })
    setStatus({ kind: 'success', message: '字幕內容已更新' })
  }

  const handleToggleLineType = (event, index) => {
    event.stopPropagation()
    const currentLine = lines[index]
    if (!socketRef.current || !sessionId || !currentLine) return
    const nextType =
      currentLine.type === 'direction' ? 'dialogue' : 'direction'

    setLines((prev) => {
      const next = [...prev]
      next[index] = { ...currentLine, type: nextType }
      return next
    })

    socketRef.current.emit('updateLine', {
      sessionId,
      index,
      text: currentLine.text,
      type: nextType,
      languageId: 'primary',
    })
  }

  const handleToggleLineMusic = (event, index) => {
    event.stopPropagation()
    if (!socketRef.current || !sessionId) return
    const checked = event.target.checked

    if (!checked) {
      const range = getMusicRangeAroundIndex(lines, index)
      const targetRange = range || { startIndex: index, endIndex: index }
      setLines((prev) =>
        applyMusicRangeState(
          prev,
          targetRange.startIndex,
          targetRange.endIndex,
          false,
        ),
      )
      setPendingMusicRangeStartIndex(null)
      socketRef.current.emit('setLineMusicRange', {
        sessionId,
        startIndex: targetRange.startIndex,
        endIndex: targetRange.endIndex,
        music: false,
      })
      setStatus({ kind: 'info', message: '已清除音樂範圍標記' })
      return
    }

    if (
      pendingMusicRangeStartIndex != null &&
      pendingMusicRangeStartIndex !== index
    ) {
      const rangeStart = Math.min(pendingMusicRangeStartIndex, index)
      const rangeEnd = Math.max(pendingMusicRangeStartIndex, index)
      setLines((prev) => applyMusicRangeState(prev, rangeStart, rangeEnd, true))
      setPendingMusicRangeStartIndex(null)
      socketRef.current.emit('setLineMusicRange', {
        sessionId,
        startIndex: rangeStart,
        endIndex: rangeEnd,
        music: true,
      })
      setStatus({
        kind: 'success',
        message: `已設定音樂範圍：第 ${rangeStart + 1} 行到第 ${rangeEnd + 1} 行`,
      })
      return
    }

    setLines((prev) => applyLineMusicState(prev, index, true))
    setPendingMusicRangeStartIndex(index)
    socketRef.current.emit('setLineMusic', {
      sessionId,
      index,
      music: true,
    })
    setStatus({
      kind: 'info',
      message: `已選擇第 ${index + 1} 行為音樂起點，請再勾選結束行`,
    })
  }

  const handleLineKeyDown = (event, index) => {
    if (event.key !== 'Enter') return
    if (event.shiftKey || event.isComposing || event.keyCode === 229) return
    if (!socketRef.current || !sessionId || !window.getSelection) return

    const node = lineRefs.current[index] ?? event.currentTarget
    if (!node) return
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      return
    }

    const range = selection.getRangeAt(0)
    if (!node.contains(range.endContainer)) return

    const beforeRange = range.cloneRange()
    beforeRange.selectNodeContents(node)
    beforeRange.setEnd(range.endContainer, range.endOffset)

    const normalizeSegment = (text, { trim = true } = {}) => {
      const cleaned = (text ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/\u200b/g, '')
        .replace(/\r?\n/g, ' ')
      return trim ? cleaned.trim() : cleaned
    }

    const fullTextRaw = normalizeSegment(node.textContent ?? '', {
      trim: false,
    })
    const normalizedFull = normalizeSegment(fullTextRaw)
    const caretTextRaw = normalizeSegment(beforeRange.toString(), {
      trim: false,
    })
    let caretOffset = caretTextRaw.length
    if (caretOffset > fullTextRaw.length) {
      caretOffset = fullTextRaw.length
    }

    let beforeText = normalizeSegment(fullTextRaw.slice(0, caretOffset))
    let afterText = normalizeSegment(fullTextRaw.slice(caretOffset))
    const combinedText = normalizeSegment(`${beforeText}${afterText}`)
    if (normalizedFull && combinedText !== normalizedFull) {
      if (afterText) {
        const fallbackLength = Math.max(
          normalizedFull.length - afterText.length,
          0,
        )
        beforeText = normalizeSegment(normalizedFull.slice(0, fallbackLength))
      } else {
        beforeText = normalizedFull
      }
    }

    const currentLine = lines[index]
    const currentType =
      typeof currentLine === 'object' && currentLine?.type === 'direction'
        ? 'direction'
        : 'dialogue'
    const currentMusic = isLineMarkedMusic(currentLine)

    if (normalizedFull) {
      setLines((prev) => {
        const next = [...prev]
        if (next[index]) {
          next[index] = {
            ...next[index],
            text: normalizedFull,
            translations: {
              ...(next[index].translations || {}),
              primary: normalizedFull,
            },
          }
        }
        return next
      })
    }

    if (!beforeText) return
    event.preventDefault()

    if (!afterText) {
      skipBlurRef.current.add(index)

      if (node.textContent !== beforeText) {
        node.textContent = beforeText
      }

      setLines((prev) => {
        const next = [...prev]
        next[index] = {
          ...next[index],
          text: beforeText,
          translations: {
            ...(next[index]?.translations || {}),
            primary: beforeText,
          },
        }
        next.splice(index + 1, 0, {
          id: `${Date.now()}-${index + 1}`,
          text: '',
          type: currentType,
          music: currentMusic,
          role: currentLine?.role || null,
          translations: { primary: '' },
        })
        return next
      })
      setCurrentIndex((prev) => (prev > index ? prev + 1 : prev))
      setPendingMusicRangeStartIndex((prev) =>
        prev != null && prev > index ? prev + 1 : prev,
      )
      setEditingIndex(index + 1)
      setAutoCenterEnabled(true)
      socketRef.current.emit('insertLineAfter', {
        sessionId,
        index,
        type: currentType,
      })
      return
    }

    skipBlurRef.current.add(index)
    if (node.textContent !== beforeText) {
      node.textContent = beforeText
    }

    setLines((prev) => {
      const next = [...prev]
      next[index] = {
        ...next[index],
        text: beforeText,
        translations: {
          ...(next[index]?.translations || {}),
          primary: beforeText,
        },
      }
      next.splice(index + 1, 0, {
        id: `${Date.now()}-${index + 1}`,
        text: afterText,
        type: currentType,
        music: currentMusic,
        role: currentLine?.role || null,
        translations: { primary: afterText },
      })
      return next
    })
    setCurrentIndex((prev) => (prev > index ? prev + 1 : prev))
    setPendingMusicRangeStartIndex((prev) =>
      prev != null && prev > index ? prev + 1 : prev,
    )
    setEditingIndex(index + 1)
    setAutoCenterEnabled(true)
    socketRef.current.emit('splitLine', {
      sessionId,
      index,
      beforeText,
      afterText,
    })
  }

  const handleDeleteLine = (event, index) => {
    event.stopPropagation()
    if (!socketRef.current || !sessionId || !lines[index]) return

    setLines((prev) => prev.filter((_, lineIndex) => lineIndex !== index))
    setCurrentIndex((prev) => {
      if (prev > index) return Math.max(prev - 1, 0)
      if (prev === index) return Math.max(index - 1, 0)
      return prev
    })
    setEditingIndex((prev) => {
      if (prev == null) return prev
      if (prev === index) return null
      if (prev > index) return prev - 1
      return prev
    })
    setPendingMusicRangeStartIndex((prev) => {
      if (prev == null) return prev
      if (prev === index) return null
      if (prev > index) return prev - 1
      return prev
    })
    socketRef.current.emit('deleteLine', { sessionId, index })
    setStatus({ kind: 'info', message: '字幕已刪除' })
  }

  const handleImportJson = async (event) => {
    const file = event.target.files?.[0]
    if (!file || !sessionId || !selectedCellId) return

    try {
      const content = await file.text()
      const parsed = JSON.parse(content)
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('檔案內容無有效字幕')
      }

      await performSessionMutation(
        () =>
          fetch(`/api/session/${sessionId}/lines`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              cellId: selectedCellId,
              lines: parsed,
            }),
          }),
        { successMessage: '字幕 JSON 已載入' },
      )
      setAutoCenterEnabled(false)
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error.message || '載入字幕檔失敗',
      })
    } finally {
      if (jsonInputRef.current) {
        jsonInputRef.current.value = ''
      }
    }
  }

  const handleExportJson = () => {
    if (!lines.length) {
      setStatus({ kind: 'info', message: '目前沒有字幕可以匯出' })
      return
    }

    const payload = JSON.stringify(lines, null, 2)
    const blob = new Blob([payload], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${selectedCell?.name || 'subtitles'}.json`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
    setStatus({ kind: 'success', message: '字幕 JSON 已匯出' })
  }

  const handleExportSessionBackup = async () => {
    if (!sessionId) return

    try {
      const response = await fetch(`/api/session/${sessionId}/backup`)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '匯出場次備份失敗')
      }

      const payload = JSON.stringify(data, null, 2)
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      const filenameBase = (sessionMeta?.title || sessionId || 'session')
        .replace(/[<>:"/\\|?*]+/g, '-')
        .trim()
      link.href = url
      link.download = `${filenameBase}.session-backup.json`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setStatus({ kind: 'success', message: '場次備份 JSON 已匯出' })
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error.message || '匯出場次備份失敗',
      })
    }
  }

  const handleParsePrimaryScript = async (event) => {
    event.preventDefault()
    if (!sessionId || !selectedCellId) return
    if (!apiKey) {
      setStatus({ kind: 'error', message: '請先填入 OpenAI API Key' })
      return
    }
    if (!primaryScriptInput.trim()) {
      setStatus({ kind: 'error', message: '請先貼上第一語言劇本文字' })
      return
    }

    try {
      setParsingPrimary(true)
      setStatus({ kind: 'info', message: '正在解析第一語言劇本…' })
      const data = await performSessionMutation(
        () =>
          fetch(`/api/session/${sessionId}/script/parse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              apiKey,
              cellId: selectedCellId,
              scriptText: primaryScriptInput,
            }),
          }),
        { successMessage: '第一語言字幕已更新', keepStatus: true },
      )
      setStatus({
        kind: data?.warning ? 'info' : 'success',
        message: data?.warning || '第一語言字幕已更新',
      })
      setAutoCenterEnabled(false)
    } finally {
      setParsingPrimary(false)
    }
  }

  const handleParseLanguageScript = async (event, languageId) => {
    event.preventDefault()
    if (!sessionId || !selectedCellId || !languageId) return
    if (!apiKey) {
      setStatus({ kind: 'error', message: '請先填入 OpenAI API Key' })
      return
    }

    const scriptText = getDraftInputValue(selectedCellId, languageId)
    if (!scriptText.trim()) {
      setStatus({ kind: 'error', message: '請先貼上目標語言文字' })
      return
    }

    try {
      setParsingLanguageId(languageId)
      setStatus({ kind: 'info', message: '正在對齊多語字幕…' })
      const data = await performSessionMutation(
        () =>
          fetch(
            `/api/session/${sessionId}/cells/${selectedCellId}/languages/${languageId}/parse`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                apiKey,
                scriptText,
              }),
            },
          ),
        { successMessage: '多語字幕已對齊', keepStatus: true },
      )
      setStatus({
        kind: data?.warning ? 'info' : 'success',
        message: data?.warning || '多語字幕已對齊',
      })
    } finally {
      setParsingLanguageId('')
    }
  }

  const handleCopyViewerLink = async () => {
    if (!viewerUrl) return
    try {
      await navigator.clipboard.writeText(viewerUrl)
      setStatus({ kind: 'success', message: '檢視端連結已複製' })
    } catch {
      setStatus({
        kind: 'error',
        message: '無法複製，請手動複製連結',
      })
    }
  }

  const handleCopyProjectorLink = async () => {
    if (!projectorUrl) return
    try {
      await navigator.clipboard.writeText(projectorUrl)
      setStatus({ kind: 'success', message: '投影端連結已複製' })
    } catch {
      setStatus({
        kind: 'error',
        message: '無法複製，請手動複製投影連結',
      })
    }
  }

  const handleOpenProjectorWindow = () => {
    if (!projectorUrl) return
    const nextWindow = window.open(projectorUrl, 'subtitle-machine-projector')
    if (nextWindow) {
      nextWindow.focus()
      setStatus({
        kind: 'info',
        message: '投影頁已開啟，請拖到外接螢幕後切換全螢幕',
      })
      return
    }
    setStatus({
      kind: 'error',
      message: '瀏覽器封鎖了新視窗，請允許彈出視窗後重試',
    })
  }

  const updateProjectorLayout = (patch, successMessage = '') => {
    if (!socketRef.current || !sessionId) return
    const nextLayout = normalizeProjectorLayout({
      ...projectorLayout,
      ...patch,
    })
    setProjectorLayout(nextLayout)
    socketRef.current.emit('updateProjectorLayout', {
      sessionId,
      layout: patch,
    })
    if (successMessage) {
      setStatus({ kind: 'success', message: successMessage })
    }
  }

  const handleProjectorSliderChange = (field) => (event) => {
    const nextValue = Number(event.target.value)
    if (!Number.isFinite(nextValue)) return
    updateProjectorLayout({ [field]: nextValue })
  }

  const handleResetProjectorLayout = () => {
    updateProjectorLayout(
      {
        fontSizePercent: 100,
        offsetX: 0,
        offsetY: 24,
      },
      '投影版面已重設',
    )
  }

  const handleDownloadQrCode = async () => {
    if (!qrCodeUrl) return
    try {
      const link = document.createElement('a')
      link.href = qrCodeUrl
      link.download = `${sessionMeta?.title || 'viewer'}-qr.png`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setStatus({ kind: 'success', message: 'QR code 已下載' })
    } catch {
      window.open(qrCodeUrl, '_blank', 'noopener,noreferrer')
      setStatus({
        kind: 'info',
        message: '無法直接下載，已改為開啟 QR code 圖片',
      })
    }
  }

  const handleCreateCell = async () => {
    if (!sessionId) return
    const name = window.prompt('儲存格名稱', `儲存格 ${cells.length + 1}`)
    if (name == null) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/cells`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      { successMessage: '已新增儲存格' },
    )
  }

  const handleRenameCell = async (cell) => {
    if (!sessionId || !cell) return
    const name = window.prompt('重新命名儲存格', cell.name || '')
    if (name == null) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/cells/${cell.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      { successMessage: '已更新儲存格名稱' },
    )
  }

  const handleSelectCell = async (cellId) => {
    if (!sessionId || !cellId) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/cells/${cellId}/select`, {
          method: 'POST',
        }),
      { keepStatus: true },
    )
  }

  const handleDeleteCell = async (cell) => {
    if (!sessionId || !cell) return
    const confirmed = window.confirm(`要刪除「${cell.name}」嗎？`)
    if (!confirmed) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/cells/${cell.id}`, {
          method: 'DELETE',
        }),
      { successMessage: '儲存格已刪除' },
    )
  }

  const handleAddLanguage = async () => {
    if (!sessionId) return
    const name = window.prompt('新增語言名稱', '第二語言')
    if (name == null) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/languages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      { successMessage: '已新增語言' },
    )
  }

  const handleDeleteLanguage = async (language) => {
    if (!sessionId || !language || language.id === 'primary') return
    const confirmed = window.confirm(`要刪除「${language.name}」嗎？`)
    if (!confirmed) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/languages/${language.id}`, {
          method: 'DELETE',
        }),
      { successMessage: '語言已刪除' },
    )
  }

  const handleEndSession = async () => {
    if (!sessionId) return
    const confirmed = window.confirm(
      '結束場次後，檢視端與投影端網址都會立即失效。要繼續嗎？',
    )
    if (!confirmed) return
    await performSessionMutation(
      () =>
        fetch(`/api/session/${sessionId}/end`, {
          method: 'POST',
        }),
      { successMessage: '場次已結束，檢視端與投影端已失效' },
    )
  }

  const currentLine = lines[currentIndex] || null
  lineRefs.current = []

  const transcriptionStatusLabelMap = {
    idle: '待命',
    connecting: '連線中',
    running: '辨識中',
    error: '錯誤',
  }
  const transcriptionStatusLabel =
    transcriptionStatusLabelMap[transcription.status] || transcription.status
  const transcriptionBusy =
    transcription.active || transcription.status === 'connecting'
  const speakerRecognitionEnabled =
    transcription.speakerRecognitionEnabled === true
  const currentLineMusicActive = isLineMarkedMusic(currentLine)
  const musicSelectionHint =
    pendingMusicRangeStartIndex != null
      ? `音樂範圍選取中：已選第 ${pendingMusicRangeStartIndex + 1} 行為起點，請再勾選結束行。`
      : '勾選音樂後，再勾選另一行可自動標記整段範圍。'
  const transcriptionPreview =
    transcription.text && transcription.text.trim().length > 0
      ? transcription.text
      : transcriptionBusy
        ? '請開始說話…'
        : '尚未啟動即時語音辨識'
  const projectorPreviewText =
    !displayEnabled
      ? '字幕已遮蔽'
      : currentLine?.type === 'direction'
        ? '舞台指示不投影'
        : resolveLineText(currentLine, projectorDefaultLanguageId) || '尚未載入字幕'
  const projectorPreviewStyle = {
    '--projector-preview-scale': projectorLayout.fontSizePercent / 100,
    '--projector-preview-left': `${50 + projectorLayout.offsetX * 0.8}%`,
    '--projector-preview-top': `${50 + projectorLayout.offsetY * 0.9}%`,
  }
  const previewRoleColor =
    roleColorEnabled && currentLine?.type !== 'direction'
      ? roleToColor(currentLine?.role)
      : ''

  if (!authReady) {
    return (
      <div className="page">
        <div className="home-intro">載入控制端中…</div>
      </div>
    )
  }

  if (!user || !sessionId) {
    return null
  }

  return (
    <div className={`control-page ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className={`control-sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <div className="sidebar-toggle-row">
          <button
            type="button"
            className="subtle-button"
            onClick={() => setSidebarCollapsed((prev) => !prev)}
          >
            {sidebarCollapsed ? '展開控制端' : '收合控制端'}
          </button>
          {!sidebarCollapsed && (
            <button
              type="button"
              className="subtle-button"
              onClick={() => navigate('/')}
            >
              返回場次列表
            </button>
          )}
        </div>

        {!sidebarCollapsed && (
          <>
            <header className="control-header">
              <div className="session-title-row">
                <div>
                  <h1>{sessionMeta?.title || '控制端'}</h1>
                  <p className="input-note">
                    {sessionMeta?.status === 'ended'
                      ? '已結束場次，檢視端與投影端網址已失效'
                      : '進行中場次'}
                  </p>
                </div>
                <span className={`session-state-badge ${sessionMeta?.status || 'active'}`}>
                  {sessionMeta?.status === 'ended' ? '已結束' : '進行中'}
                </span>
              </div>

              <div className="input-group">
                <label htmlFor="openai-key">OpenAI API Key</label>
                <input
                  id="openai-key"
                  type="password"
                  placeholder="sk-..."
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value.trim())}
                />
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={rememberKey}
                    onChange={(event) => setRememberKey(event.target.checked)}
                  />
                  在此裝置記住 API Key
                </label>
              </div>

              <div className="input-group">
                <label>檢視端亂碼網址</label>
                <div className="viewer-link">
                  <span>{viewerUrl || '尚未建立場次'}</span>
                  <button type="button" onClick={handleCopyViewerLink}>
                    複製
                  </button>
                </div>
                {viewerUrl && (
                  <div className="qr-preview-card">
                    <img src={qrCodeUrl} alt="Viewer QR Code" />
                    <button type="button" onClick={handleDownloadQrCode}>
                      下載 QR code
                    </button>
                  </div>
                )}
              </div>

              <div className="input-group">
                <label>投影端網址</label>
                <div className="viewer-link">
                  <span>{projectorUrl || '尚未建立場次'}</span>
                  <button type="button" onClick={handleCopyProjectorLink}>
                    複製
                  </button>
                </div>
                <div className="projector-link-actions">
                  <button type="button" className="subtle-button" onClick={handleOpenProjectorWindow}>
                    開啟投影頁
                  </button>
                  <button type="button" className="subtle-button" onClick={handleResetProjectorLayout}>
                    重設版面
                  </button>
                </div>
                <div className="projector-layout-card">
                  <label className="range-control">
                    <span>字體大小</span>
                    <strong>{projectorLayout.fontSizePercent}%</strong>
                    <input
                      type="range"
                      min="60"
                      max="220"
                      step="5"
                      value={projectorLayout.fontSizePercent}
                      onChange={handleProjectorSliderChange('fontSizePercent')}
                    />
                  </label>
                  <label className="range-control">
                    <span>左右位置</span>
                    <strong>{projectorLayout.offsetX}</strong>
                    <input
                      type="range"
                      min="-35"
                      max="35"
                      step="1"
                      value={projectorLayout.offsetX}
                      onChange={handleProjectorSliderChange('offsetX')}
                    />
                  </label>
                  <label className="range-control">
                    <span>上下位置</span>
                    <strong>{projectorLayout.offsetY}</strong>
                    <input
                      type="range"
                      min="-20"
                      max="35"
                      step="1"
                      value={projectorLayout.offsetY}
                      onChange={handleProjectorSliderChange('offsetY')}
                    />
                  </label>
                </div>
                <span className="input-note">
                  請使用延伸桌面，將投影頁移到外接螢幕後切換全螢幕。
                </span>
              </div>
            </header>

            <div className="input-group">
              <div className="section-header-inline">
                <label>儲存格</label>
                <button type="button" className="subtle-button" onClick={handleCreateCell}>
                  新增儲存格
                </button>
              </div>
              <div className="cell-list">
                {cells.map((cell) => (
                  <div
                    key={cell.id}
                    className={`cell-card ${cell.id === selectedCellId ? 'active' : ''}`}
                  >
                    <button
                      type="button"
                      className="cell-main-button"
                      onClick={() => handleSelectCell(cell.id)}
                    >
                      <strong>{cell.name}</strong>
                      <span>{cell.lineCount || 0} 行字幕</span>
                    </button>
                    <div className="cell-card-actions">
                      <button
                        type="button"
                        className="subtle-button"
                        onClick={() => handleRenameCell(cell)}
                      >
                        重新命名
                      </button>
                      <button
                        type="button"
                        className="subtle-button danger-button"
                        onClick={() => handleDeleteCell(cell)}
                        disabled={cells.length <= 1}
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="input-group">
              <div className="section-header-inline">
                <label>語言</label>
                <button type="button" className="subtle-button" onClick={handleAddLanguage}>
                  新增語言
                </button>
              </div>
              <div className="language-pill-list">
                {languages.map((language) => (
                  <div key={language.id} className="language-pill">
                    <span>{language.name}</span>
                    {language.id !== 'primary' && (
                      <button
                        type="button"
                        className="language-pill-delete"
                        onClick={() => handleDeleteLanguage(language)}
                      >
                        刪除
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="input-group">
              <label>外部字幕預設語言</label>
              <div className="language-default-grid">
                <label className="input-group" htmlFor="viewer-default-language">
                  <span>檢視端預設</span>
                  <select
                    id="viewer-default-language"
                    value={viewerDefaultLanguageId}
                    onChange={handleViewerDefaultLanguageChange}
                  >
                    {languages.map((language) => (
                      <option key={language.id} value={language.id}>
                        {language.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="input-group" htmlFor="projector-default-language">
                  <span>投影端播放</span>
                  <select
                    id="projector-default-language"
                    value={projectorDefaultLanguageId}
                    onChange={handleProjectorDefaultLanguageChange}
                  >
                    {languages.map((language) => (
                      <option key={language.id} value={language.id}>
                        {language.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <span className="input-note">
                檢視端初次進入會先套用預設語言，但觀眾之後仍可自行切換；投影端則會持續跟著這裡的設定。
              </span>
            </div>

            <form className="input-group" onSubmit={handleParsePrimaryScript}>
              <label htmlFor="script-text-primary">第一語言劇本文字</label>
              <textarea
                id="script-text-primary"
                rows={8}
                placeholder="貼上第一語言全文，系統會解析角色、分段並寫入目前儲存格。"
                value={primaryScriptInput}
                onChange={(event) =>
                  setDraftInputValue(selectedCellId, 'primary', event.target.value)
                }
              />
              <span className="input-note">
                角色會被保留到字幕資料裡，可由控制端切換是否用顏色區分。
              </span>
              <button type="submit" disabled={parsingPrimary || !selectedCellId}>
                {parsingPrimary ? '解析中…' : '解析第一語言'}
              </button>
            </form>

            {extraLanguages.map((language) => (
              <form
                key={language.id}
                className="input-group language-parse-card"
                onSubmit={(event) => handleParseLanguageScript(event, language.id)}
              >
                <label htmlFor={`language-input-${language.id}`}>
                  {language.name}
                </label>
                <textarea
                  id={`language-input-${language.id}`}
                  rows={5}
                  placeholder={`貼上 ${language.name} 全文，系統會依第一語言分段對齊。`}
                  value={getDraftInputValue(selectedCellId, language.id)}
                  onChange={(event) =>
                    setDraftInputValue(selectedCellId, language.id, event.target.value)
                  }
                />
                <button
                  type="submit"
                  disabled={
                    parsingLanguageId === language.id || !selectedCellId || !lines.length
                  }
                >
                  {parsingLanguageId === language.id ? '對齊中…' : `解析 ${language.name}`}
                </button>
              </form>
            ))}

            <div className="input-group">
              <label>目前儲存格字幕 JSON 匯入 / 匯出</label>
              <div className="json-actions">
                <button type="button" onClick={() => jsonInputRef.current?.click()}>
                  匯入目前儲存格 JSON
                </button>
                <button type="button" onClick={handleExportJson}>
                  匯出目前儲存格 JSON
                </button>
                <input
                  ref={jsonInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={handleImportJson}
                />
              </div>
              <span className="input-note">
                這裡只會處理目前選取儲存格的字幕內容，不包含整個場次設定。
              </span>
            </div>

            <div className="input-group">
              <label>場次備份 JSON</label>
              <div className="json-actions">
                <button type="button" onClick={handleExportSessionBackup}>
                  匯出場次備份 JSON
                </button>
              </div>
              <span className="input-note">
                會匯出整個場次的語言、所有儲存格、字幕內容、投影設定與原本場次 ID，可到首頁再匯入還原。
              </span>
            </div>

            <div className="control-actions">
              <button
                type="button"
                className={`toggle-button ${displayEnabled ? 'active' : ''}`}
                onClick={handleToggleDisplay}
              >
                {displayEnabled ? '遮蔽檢視端 / 投影字幕' : '重新顯示外部字幕'}
              </button>
              <button
                type="button"
                className="subtle-button"
                onClick={handleUndo}
                disabled={!historyState.canUndo}
              >
                上一步
              </button>
              <button
                type="button"
                className="subtle-button"
                onClick={handleRedo}
                disabled={!historyState.canRedo}
              >
                還原
              </button>
              <button
                type="button"
                className="subtle-button danger-button"
                onClick={handleEndSession}
                disabled={sessionMeta?.status === 'ended'}
              >
                結束場次
              </button>
            </div>

            <div className="input-group transcription-panel">
              <label>即時語音辨識（雲端）</label>
              <label htmlFor="transcription-context">辨識主題 / 術語提示</label>
              <textarea
                id="transcription-context"
                rows={4}
                maxLength={600}
                placeholder="例如：主題、關鍵詞、專有名詞"
                value={transcription.transcriptionContext}
                disabled={transcriptionBusy}
                onChange={(event) => {
                  setTranscription((prev) => ({
                    ...prev,
                    transcriptionContext: event.target.value,
                  }))
                }}
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={speakerRecognitionEnabled}
                  disabled={transcriptionBusy}
                  onChange={(event) => {
                    setTranscription((prev) => ({
                      ...prev,
                      speakerRecognitionEnabled: event.target.checked,
                    }))
                  }}
                />
                辨認講者
              </label>
              <div className="transcription-actions">
                <button
                  type="button"
                  onClick={handleStartLiveTranscription}
                  disabled={transcriptionBusy}
                >
                  {transcription.status === 'connecting'
                    ? '連線中…'
                    : transcription.active
                      ? '辨識中'
                      : '開始收音'}
                </button>
                <button
                  type="button"
                  className="subtle-button"
                  onClick={handleStopLiveTranscription}
                  disabled={!transcriptionBusy}
                >
                  停止收音
                </button>
              </div>
              <div className="transcription-meta">
                <span>狀態：{transcriptionStatusLabel}</span>
                <span>輸出：{transcription.isFinal ? '最終稿' : '即時草稿'}</span>
                <span>講者：{speakerRecognitionEnabled ? '辨認中' : '關閉'}</span>
              </div>
              <div
                className={`transcription-preview ${
                  transcription.isFinal ? 'final' : 'partial'
                }`}
              >
                {transcriptionPreview}
              </div>
            </div>

            <div className="viewer-preview">
              <label>投影預覽</label>
              <label className="checkbox-row viewer-preview-toggle">
                <input
                  type="checkbox"
                  checked={roleColorEnabled}
                  onChange={handleToggleRoleColorEnabled}
                />
                顏色分辨角色
              </label>
              <div
                className={`viewer-preview-box ${
                  displayEnabled ? '' : 'viewer-muted'
                } ${
                  currentLine?.type === 'direction' ? 'viewer-direction' : ''
                } ${
                  currentLineMusicActive ? 'viewer-music-preview' : ''
                }`}
                style={projectorPreviewStyle}
              >
                <div className="viewer-preview-stage">
                  <div
                    className="viewer-preview-text"
                    style={previewRoleColor ? { color: previewRoleColor } : undefined}
                  >
                    {projectorPreviewText}
                  </div>
                </div>
              </div>
              {currentLine?.role && (
                <div
                  className="viewer-preview-role"
                  style={previewRoleColor ? { color: previewRoleColor } : undefined}
                >
                  角色：{currentLine.role}
                </div>
              )}
              {currentLineMusicActive && (
                <div className="viewer-preview-music">此處有音樂</div>
              )}
              <div className="control-instructions">
                • 上下方向鍵切換字幕
                <br />
                • `Cmd/Ctrl + Z` 復原，`Shift + Cmd/Ctrl + Z` 還原
                <br />
                • 觀眾進入檢視端會先套用預設語言，之後仍可自行切換語言與字級
              </div>
            </div>

            <div
              className={`status-bar ${
                status.kind === 'success'
                  ? 'status-success'
                  : status.kind === 'error'
                    ? 'status-error'
                    : ''
              }`}
            >
              {status.message}
            </div>
          </>
        )}
      </aside>

      <section className="script-panel">
        <header className="script-header">
          <div>
            <h2>{selectedCell?.name || '劇本字幕清單'}</h2>
            <div className="script-header-meta">
              <small>
                {lines.length
                  ? `目前進度：${currentIndex + 1} / ${lines.length}`
                  : '尚未載入字幕'}
              </small>
              <small className="script-music-hint">{musicSelectionHint}</small>
            </div>
          </div>
          <div className="script-toolbar">
            <button
              type="button"
              className="subtle-button"
              onClick={handleUndo}
              disabled={!historyState.canUndo}
            >
              上一步
            </button>
            <button
              type="button"
              className="subtle-button"
              onClick={handleRedo}
              disabled={!historyState.canRedo}
            >
              還原
            </button>
          </div>
        </header>

        <div className="script-list">
          {lines.length === 0 && (
            <p className="empty-hint">
              尚未載入字幕，請先解析第一語言劇本，或匯入 JSON 到目前儲存格。
            </p>
          )}
          {lines.map((line, index) => {
            const lineText =
              typeof line === 'string' ? line : line?.text ?? ''
            const lineType =
              typeof line === 'object' && line?.type === 'direction'
                ? 'direction'
                : 'dialogue'
            const musicActive = isLineMarkedMusic(line)
            const previousMusicActive = isLineMarkedMusic(lines[index - 1])
            const nextMusicActive = isLineMarkedMusic(lines[index + 1])
            const translatedCount = extraLanguages.filter(
              (language) => line?.translations?.[language.id]?.trim(),
            ).length
            const musicBoundaryLabel = musicActive
              ? !previousMusicActive && !nextMusicActive
                ? '音樂'
                : !previousMusicActive
                  ? '音樂起'
                  : !nextMusicActive
                    ? '音樂迄'
                    : '音樂中'
              : ''

            return (
              <div
                key={line.id || `${index}-${lineText.slice(0, 10)}`}
                className={`script-line ${
                  currentIndex === index ? 'active' : ''
                } ${lineType === 'direction' ? 'direction' : ''} ${
                  musicActive ? 'music' : ''
                } ${musicActive && !previousMusicActive ? 'music-start' : ''} ${
                  musicActive && !nextMusicActive ? 'music-end' : ''
                }`}
                onClick={() => handleJumpToLine(index)}
              >
                <div className="script-line-header">
                  <div className="script-line-tags">
                    <span
                      className={`script-line-type ${
                        lineType === 'direction'
                          ? 'type-direction'
                          : 'type-dialogue'
                      }`}
                    >
                      {lineType === 'direction' ? '舞台' : '台詞'}
                    </span>
                    {line.role && (
                      <span className="script-line-type type-role">
                        {line.role}
                      </span>
                    )}
                    {translatedCount > 0 && (
                      <span className="script-line-type type-language">
                        {translatedCount} 語已對齊
                      </span>
                    )}
                    {musicBoundaryLabel && (
                      <span className="script-line-type type-music">
                        {musicBoundaryLabel}
                      </span>
                    )}
                  </div>

                  <div className="script-line-actions">
                    <label
                      className="line-music-toggle"
                      onClick={(lineEvent) => lineEvent.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={musicActive}
                        onChange={(lineEvent) =>
                          handleToggleLineMusic(lineEvent, index)
                        }
                      />
                      音樂
                    </label>
                    <button
                      type="button"
                      className="line-action toggle"
                      onClick={(lineEvent) =>
                        handleToggleLineType(lineEvent, index)
                      }
                    >
                      {lineType === 'direction' ? '改成台詞' : '改成舞台'}
                    </button>
                    <button
                      type="button"
                      className="line-action delete"
                      onClick={(lineEvent) => handleDeleteLine(lineEvent, index)}
                    >
                      刪除
                    </button>
                  </div>
                </div>

                <div
                  ref={(node) => {
                    lineRefs.current[index] = node
                  }}
                  className={`script-line-text ${
                    editingIndex === index ? 'editing' : ''
                  }`}
                  contentEditable={editingIndex === index}
                  suppressContentEditableWarning
                  spellCheck={false}
                  tabIndex={0}
                  onClick={(event) => handleLineTextClick(event, index)}
                  onDoubleClick={(event) => handleLineTextDoubleClick(event, index)}
                  onBlur={(event) => handleLineBlur(event, index)}
                  onKeyDown={(event) => handleLineKeyDown(event, index)}
                >
                  {lineText}
                </div>

                {translatedCount > 0 && (
                  <div className="line-language-preview">
                    {extraLanguages
                      .filter((language) => line?.translations?.[language.id]?.trim())
                      .map((language) => (
                        <span key={language.id} className="line-language-chip">
                          {language.name}
                        </span>
                      ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

export default ControlPage
