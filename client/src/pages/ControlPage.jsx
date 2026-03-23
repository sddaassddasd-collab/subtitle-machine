import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { io } from 'socket.io-client'

const DEFAULT_SESSION_ID = 'default'
const ACCESS_CODE = '20141017'

const storageKeys = {
  apiKey: 'subtitleMachineApiKey',
  rememberKey: 'subtitleMachineRememberKey',
}

const DEFAULT_TRANSCRIPTION_STATE = {
  active: false,
  status: 'idle',
  text: '',
  isFinal: true,
  language: null,
  model: 'gpt-4o-mini-transcribe',
  error: '',
  updatedAt: null,
}

const TARGET_SAMPLE_RATE = 24000

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
      typeof raw.model === 'string' && raw.model.trim().length > 0
        ? raw.model
        : 'gpt-4o-mini-transcribe',
    language:
      typeof raw.language === 'string' && raw.language.trim().length > 0
        ? raw.language
        : null,
    updatedAt:
      typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
        ? raw.updatedAt
        : null,
  }
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

const ControlPage = () => {
  const location = useLocation()
  const navigate = useNavigate()
  const query = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  )
  const initialSessionId = query.get('session') || DEFAULT_SESSION_ID

  const [sessionId, setSessionId] = useState(initialSessionId)
  const [lines, setLines] = useState([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [displayEnabled, setDisplayEnabled] = useState(true)
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
  const [uploading, setUploading] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  const [editingIndex, setEditingIndex] = useState(null)
  const [autoCenterEnabled, setAutoCenterEnabled] = useState(false)
  const [authenticated, setAuthenticated] = useState(false)
  const [accessInput, setAccessInput] = useState('')
  const [accessError, setAccessError] = useState('')
  const socketRef = useRef(null)
  const fileInputRef = useRef(null)
  const jsonInputRef = useRef(null)
  const lineRefs = useRef([])
  const skipBlurRef = useRef(new Set())
  const lastTranscriptionErrorRef = useRef('')
  const captureStateRef = useRef({
    mediaStream: null,
    audioContext: null,
    sourceNode: null,
    processorNode: null,
    silenceNode: null,
  })

  const releaseMicrophoneCapture = () => {
    const state = captureStateRef.current
    if (!state) return

    const {
      processorNode,
      sourceNode,
      silenceNode,
      audioContext,
      mediaStream,
    } = state

    if (processorNode) {
      try {
        processorNode.onaudioprocess = null
        processorNode.disconnect()
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
      processorNode: null,
      silenceNode: null,
    }
  }

  useEffect(() => {
    if (editingIndex == null) return
    const node = lineRefs.current[editingIndex]
    if (!node) return

    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

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
    const node = lineRefs.current[currentIndex]
    if (!node) return

    if (!autoCenterEnabled) {
      if (currentIndex === 0) {
        return
      }
      setAutoCenterEnabled(true)
    }

    node.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: autoCenterEnabled ? 'smooth' : 'auto',
    })
  }, [currentIndex, lines, autoCenterEnabled])

  const viewerUrl = useMemo(() => {
    if (typeof window === 'undefined') return ''
    const origin = window.location.origin
    return `${origin}/viewer`
  }, [])

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
    if (!authenticated) return

    let cancelled = false
    const ensureDefaultSession = async () => {
      try {
        const response = await fetch('/api/session', {
          method: 'POST',
        })

        if (!response.ok) {
          throw new Error('無法建立新的場次，請稍後再試')
        }

        const data = await response.json()
        if (!cancelled) {
          const nextSessionId = data.sessionId || DEFAULT_SESSION_ID
          setSessionId(nextSessionId)
          if (location.search) {
            navigate('/control', { replace: true })
          }
        }
      } catch (error) {
        console.error(error)
        if (!cancelled) {
          setStatus({
            kind: 'error',
            message: error.message || '無法建立場次',
          })
        }
      }
    }

    ensureDefaultSession()
    return () => {
      cancelled = true
    }
  }, [navigate, location.search, authenticated])

  useEffect(() => {
    if (!authenticated || !sessionId) return

    let disposed = false
    const socket = io()
    socketRef.current = socket

    const applySessionPayload = (payload) => {
      if (disposed) return
      setLines(Array.isArray(payload.lines) ? payload.lines : [])
      setCurrentIndex(
        Number.isInteger(payload.currentIndex) ? payload.currentIndex : 0,
      )
      setDisplayEnabled(
        typeof payload.displayEnabled === 'boolean'
          ? payload.displayEnabled
          : true,
      )
      setTranscription(normalizeTranscriptionState(payload.transcription))
    }

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
        applySessionPayload(data)
        if (!disposed) {
          setStatus((prev) =>
            prev.kind === 'error' ? { kind: 'info', message: '' } : prev,
          )
        }
      } catch (error) {
        if (disposed) return
        setStatus({
          kind: 'error',
          message:
            error?.message || '找不到場次或無法載入資料',
        })
      }
    }

    const rejoinAndRefresh = () => {
      joinSession()
      refreshSession()
    }

    const handleControlUpdate = (payload) => {
      applySessionPayload(payload)
    }

    const handleTranscriptionUpdate = (payload) => {
      setTranscription(
        normalizeTranscriptionState(payload?.transcription),
      )
    }

    const handleTranscriptionError = (payload) => {
      const message =
        payload && typeof payload.message === 'string'
          ? payload.message
          : '即時語音辨識發生錯誤'
      setStatus({
        kind: 'error',
        message,
      })
    }

    socket.on('connect', rejoinAndRefresh)
    socket.on('reconnect', rejoinAndRefresh)
    socket.on('control:update', handleControlUpdate)
    socket.on('control:transcription', handleTranscriptionUpdate)
    socket.on('transcription:error', handleTranscriptionError)

    if (socket.connected) {
      rejoinAndRefresh()
    } else {
      refreshSession()
    }

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') {
        return
      }
      if (document.visibilityState !== 'visible') {
        return
      }
      if (!socket.connected) {
        socket.connect()
      } else {
        rejoinAndRefresh()
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange)
    }

    return () => {
      disposed = true
      releaseMicrophoneCapture()
      if (sessionId) {
        socket.emit('transcription:stop', { sessionId })
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange)
      }
      socket.off('connect', rejoinAndRefresh)
      socket.off('reconnect', rejoinAndRefresh)
      socket.off('control:update', handleControlUpdate)
      socket.off('control:transcription', handleTranscriptionUpdate)
      socket.off('transcription:error', handleTranscriptionError)
      socket.disconnect()
      socketRef.current = null
    }
  }, [sessionId, authenticated])

  useEffect(() => {
    if (!authenticated || !sessionId) return

    const handleKeyDown = (event) => {
      const key = event.key

      const activeElement = document.activeElement
      if (
        activeElement &&
        (activeElement.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeElement.tagName))
      ) {
        return
      }

      if (event.metaKey && key.toLowerCase() === 'm') {
        if (!socketRef.current || !sessionId) return
        event.preventDefault()
        const nextState = !displayEnabled
        socketRef.current.emit('setDisplay', {
          sessionId,
          displayEnabled: nextState,
        })
        setDisplayEnabled(nextState)
        setStatus({
          kind: 'info',
          message: nextState ? '檢視端已重新顯示' : '檢視端已遮蔽字幕',
        })
        return
      }

      if (!['ArrowUp', 'ArrowDown'].includes(key)) {
        return
      }

      if (!socketRef.current) return
      event.preventDefault()

      const delta = key === 'ArrowUp' ? -1 : 1
      socketRef.current.emit('shiftIndex', { sessionId, delta })
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [sessionId, displayEnabled, authenticated])

  useEffect(() => {
    return () => {
      releaseMicrophoneCapture()
    }
  }, [])

  useEffect(() => {
    if (transcription.active || transcription.status === 'connecting') {
      return
    }

    const state = captureStateRef.current
    if (state?.mediaStream || state?.audioContext || state?.processorNode) {
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

  const handleAccessSubmit = (event) => {
    event.preventDefault()
    if (accessInput.trim() === ACCESS_CODE) {
      setAuthenticated(true)
      setAccessError('')
      setAccessInput('')
    } else {
      setAccessError('密碼錯誤，請再試一次')
    }
  }

  const handleFileChange = (event) => {
    const file = event.target.files?.[0]
    setSelectedFile(file ?? null)
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
      message: nextState ? '檢視端已重新顯示' : '檢視端已遮蔽字幕',
    })
  }

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
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      })

      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) {
        throw new Error('瀏覽器不支援 AudioContext')
      }

      const audioContext = new AudioContextClass()
      await audioContext.resume()

      const sourceNode = audioContext.createMediaStreamSource(stream)
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1)
      const silenceNode = audioContext.createGain()
      silenceNode.gain.value = 0

      sourceNode.connect(processorNode)
      processorNode.connect(silenceNode)
      silenceNode.connect(audioContext.destination)

      captureStateRef.current = {
        mediaStream: stream,
        audioContext,
        sourceNode,
        processorNode,
        silenceNode,
      }

      processorNode.onaudioprocess = (event) => {
        const socket = socketRef.current
        if (!socket || !sessionId) return

        const sourceSamples = event.inputBuffer.getChannelData(0)
        const downsampled = downsampleFloat32(
          sourceSamples,
          audioContext.sampleRate,
          TARGET_SAMPLE_RATE,
        )
        if (!downsampled.length) return

        const pcm16 = float32ToInt16(downsampled)
        const audio = int16ToBase64(pcm16)
        if (!audio) return

        socket.emit('transcription:audio', {
          sessionId,
          audio,
        })
      }

      socketRef.current.emit('transcription:start', {
        sessionId,
        apiKey,
        model: transcription.model || 'gpt-4o-mini-transcribe',
        language: transcription.language || 'zh',
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
    if (!socketRef.current || !sessionId) return
    setEditingIndex(null)
    socketRef.current.emit('setCurrentIndex', { sessionId, index })
    setCurrentIndex(index)
  }

  const handleLineBlur = (event, index) => {
    if (skipBlurRef.current.has(index)) {
      skipBlurRef.current.delete(index)
      return
    }
    if (editingIndex !== index) return
    setEditingIndex(null)
    const newText = event.currentTarget.textContent ?? ''
    if (!socketRef.current || !sessionId) return
    const currentLine = lines[index]
    const currentText = typeof currentLine === 'object' ? currentLine?.text ?? '' : ''
    if (newText === currentText) return

    socketRef.current.emit('updateLine', {
      sessionId,
      index,
      text: newText,
    })
    setLines((prev) => {
      const next = [...prev]
      const previous = next[index]
      if (typeof previous === 'object' && previous) {
        next[index] = { ...previous, text: newText }
      } else {
        next[index] = { text: newText }
      }
      return next
    })
    setStatus({ kind: 'success', message: '字幕內容已更新' })
  }

  const handleToggleLineType = (event, index) => {
    event.stopPropagation()
    if (!socketRef.current || !sessionId) return
    const currentLine = lines[index]
    if (!currentLine || typeof currentLine !== 'object') return

    const nextType =
      currentLine.type === 'direction' ? 'dialogue' : 'direction'

    setLines((prev) => {
      const next = [...prev]
      const existing = prev[index]
      if (!existing || typeof existing !== 'object') return prev
      next[index] = { ...existing, type: nextType }
      return next
    })

    socketRef.current.emit('updateLine', {
      sessionId,
      index,
      text: currentLine.text,
      type: nextType,
    })

    setStatus({
      kind: 'success',
      message: nextType === 'direction' ? '已標記為舞台指示' : '已標記為台詞',
    })
  }

  const handleLineKeyDown = (event, index) => {
    if (event.key !== 'Enter') {
      return
    }

    if (event.shiftKey || event.isComposing || event.keyCode === 229) {
      return
    }

    if (!socketRef.current || !sessionId) return
    const node = lineRefs.current[index] ?? event.currentTarget
    if (!node) return

    if (
      typeof window === 'undefined' ||
      typeof document === 'undefined' ||
      !window.getSelection
    ) {
      return
    }

    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return
    if (!selection.isCollapsed) return

    const range = selection.getRangeAt(0)
    if (!node.contains(range.endContainer)) {
      return
    }

    const beforeRange = range.cloneRange()
    beforeRange.selectNodeContents(node)
    beforeRange.setEnd(range.endContainer, range.endOffset)

    const afterRange = range.cloneRange()
    afterRange.selectNodeContents(node)
    afterRange.setStart(range.endContainer, range.endOffset)

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

    if (normalizedFull) {
      setLines((prev) => {
        const existing = prev[index]
        const existingText =
          typeof existing === 'object' && existing
            ? existing.text ?? ''
            : typeof existing === 'string'
              ? existing
              : ''

        if (existingText === normalizedFull) {
          return prev
        }

        const next = [...prev]
        if (typeof existing === 'object' && existing) {
          next[index] = { ...existing, text: normalizedFull }
        } else {
          next[index] = { text: normalizedFull, type: currentType }
        }
        return next
      })
    }

    if (!beforeText) {
      return
    }

    event.preventDefault()

    if (!afterText) {
      skipBlurRef.current.add(index)

      if (node.textContent !== beforeText) {
        node.textContent = beforeText
      }

      setLines((prev) => {
        const next = [...prev]
        const existing = prev[index]
        if (typeof existing === 'object' && existing) {
          next[index] = { ...existing, text: beforeText }
        } else {
          next[index] = { text: beforeText, type: currentType }
        }
        next.splice(index + 1, 0, {
          text: '',
          type: currentType,
        })
        return next
      })
      setCurrentIndex((prev) => (prev > index ? prev + 1 : prev))
      setEditingIndex(index + 1)
      setAutoCenterEnabled(true)
      socketRef.current.emit('insertLineAfter', {
        sessionId,
        index,
        type: currentType,
      })
      setStatus({ kind: 'info', message: '已新增空白字幕' })
      return
    }

    skipBlurRef.current.add(index)

    if (node.textContent !== beforeText) {
      node.textContent = beforeText
    }

    setLines((prev) => {
      const next = [...prev]
      const existing = prev[index]
      if (typeof existing === 'object' && existing) {
        next[index] = { ...existing, text: beforeText }
      } else {
        next[index] = { text: beforeText, type: currentType }
      }
      next.splice(index + 1, 0, {
        text: afterText,
        type: currentType,
      })
      return next
    })

    setCurrentIndex((prev) => (prev > index ? prev + 1 : prev))
    setEditingIndex(index + 1)
    setAutoCenterEnabled(true)
    socketRef.current.emit('splitLine', {
      sessionId,
      index,
      beforeText,
      afterText,
    })
    setStatus({ kind: 'success', message: '字幕已分割' })
  }

  const handleDeleteLine = (event, index) => {
    event.stopPropagation()
    if (!socketRef.current || !sessionId) return
    if (!lines[index]) return

    setLines((prev) => prev.filter((_, lineIndex) => lineIndex !== index))
    setCurrentIndex((prev) => {
      if (prev > index) return Math.max(prev - 1, 0)
      if (prev === index) {
        return Math.max(index - 1, 0)
      }
      return prev
    })
    setEditingIndex((prev) => {
      if (prev == null) return prev
      if (prev === index) return null
      if (prev > index) return prev - 1
      return prev
    })
    socketRef.current.emit('deleteLine', { sessionId, index })
    setStatus({ kind: 'info', message: '字幕已刪除' })
  }

  const handleLineClick = (index) => {
    if (editingIndex === index) return
    if (index > 0) {
      setAutoCenterEnabled(true)
    }
    handleJumpToLine(index)
  }

  const handleLineDoubleClick = (index) => {
    setEditingIndex(index)
  }

  const handleImportJson = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const content = await file.text()
      const parsed = JSON.parse(content)
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('檔案內容無有效字幕')
      }

      const response = await fetch(`/api/session/${sessionId}/lines`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ lines: parsed }),
      })

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}))
        throw new Error(errorBody.error || '無法載入字幕檔')
      }

      const data = await response.json()
      setLines(Array.isArray(data.lines) ? data.lines : [])
      setCurrentIndex(
        Number.isInteger(data.currentIndex) ? data.currentIndex : 0,
      )
      setDisplayEnabled(
        typeof data.displayEnabled === 'boolean'
          ? data.displayEnabled
          : true,
      )
      setTranscription(normalizeTranscriptionState(data.transcription))
      setStatus({ kind: 'success', message: '字幕 JSON 已載入' })
      setAutoCenterEnabled(false)
    } catch (error) {
      console.error(error)
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

    try {
      const payload = JSON.stringify(lines, null, 2)
      const blob = new Blob([payload], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      link.download = `subtitles-${timestamp}.json`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      setStatus({ kind: 'success', message: '字幕 JSON 已匯出' })
    } catch (error) {
      console.error(error)
      setStatus({
        kind: 'error',
        message: '匯出字幕檔失敗',
      })
    }
  }

  const handleUploadScript = async (event) => {
    event.preventDefault()
    if (!sessionId) {
      setStatus({ kind: 'error', message: '尚未建立場次，無法上傳' })
      return
    }
    if (!apiKey) {
      setStatus({ kind: 'error', message: '請先填入 OpenAI API Key' })
      return
    }
    if (!selectedFile) {
      setStatus({ kind: 'error', message: '請選擇要上傳的劇本檔案' })
      return
    }

    try {
      setUploading(true)
      setStatus({ kind: 'info', message: '正在解析劇本，請稍候…' })

      const formData = new FormData()
      formData.append('script', selectedFile)
      formData.append('apiKey', apiKey)

      const response = await fetch(
        `/api/session/${sessionId}/script/upload`,
        {
          method: 'POST',
          body: formData,
        },
      )

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}))
        const message = errorBody.error || '解析劇本失敗'
        const rawDetails = errorBody.details
        const details =
          typeof rawDetails === 'string'
            ? rawDetails.length > 160
              ? `${rawDetails.slice(0, 160)}…`
              : rawDetails
            : ''
        const code = errorBody.code
        const combined =
          details && details !== message
            ? `${message}：${details}`
            : message
        throw new Error(
          code && code !== 'UNKNOWN' ? `${combined}（${code}）` : combined,
        )
      }

      const data = await response.json()
      setLines(Array.isArray(data.lines) ? data.lines : [])
      setCurrentIndex(
        Number.isInteger(data.currentIndex) ? data.currentIndex : 0,
      )
      setDisplayEnabled(
        typeof data.displayEnabled === 'boolean'
          ? data.displayEnabled
          : true,
      )
      setTranscription(normalizeTranscriptionState(data.transcription))
      const nextStatus =
        data.warning && data.warning.length > 0
          ? { kind: 'info', message: data.warning }
          : { kind: 'success', message: '劇本解析完成，可以開始播放' }
      setStatus(nextStatus)
      setAutoCenterEnabled(false)

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      setSelectedFile(null)
    } catch (error) {
      console.error(error)
      setStatus({
        kind: 'error',
        message: error.message || '上傳失敗，請重試',
      })
    } finally {
      setUploading(false)
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
        message: '無法複製，請手動選取文字複製',
      })
    }
  }

  if (!authenticated) {
    return (
      <div className="control-page locked">
        <form className="access-panel" onSubmit={handleAccessSubmit}>
          <h2>請輸入存取密碼</h2>
          <input
            type="password"
            placeholder="Access Code"
            value={accessInput}
            onChange={(event) => {
              setAccessInput(event.target.value)
              if (accessError) setAccessError('')
            }}
          />
          {accessError && <div className="status-error">{accessError}</div>}
          <button type="submit">解鎖</button>
        </form>
      </div>
    )
  }

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
  const transcriptionPreview =
    transcription.text && transcription.text.trim().length > 0
      ? transcription.text
      : transcriptionBusy
        ? '請開始說話…'
        : '尚未啟動即時語音辨識'

  return (
    <div className="control-page">
      <section className="control-sidebar">
        <header className="control-header">
          <h1>控制端</h1>
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
            <label>檢視端分享連結</label>
            <div className="viewer-link">
              <span>{viewerUrl || '尚未建立場次'}</span>
              <button type="button" onClick={handleCopyViewerLink}>
                複製
              </button>
            </div>
          </div>
        </header>

        <form className="input-group" onSubmit={handleUploadScript}>
          <label htmlFor="script-file">上傳劇本文字檔 (.txt)</label>
          <input
            id="script-file"
            ref={fileInputRef}
            type="file"
            accept=".txt,.md,.text"
            onChange={handleFileChange}
          />
          <button type="submit" disabled={uploading}>
            {uploading ? '解析中…' : '使用 OpenAI 拆解字幕'}
          </button>
        </form>

        <div className="input-group">
          <label>字幕 JSON 匯入 / 匯出</label>
          <div className="json-actions">
            <button type="button" onClick={() => jsonInputRef.current?.click()}>
              匯入 JSON
            </button>
            <button type="button" onClick={handleExportJson}>
              匯出 JSON
            </button>
            <input
              ref={jsonInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={handleImportJson}
            />
          </div>
        </div>

        <div className="control-actions">
          <button
            type="button"
            className={`toggle-button ${displayEnabled ? 'active' : ''}`}
            onClick={handleToggleDisplay}
          >
            {displayEnabled ? '遮蔽檢視端字幕' : '重新顯示字幕'}
          </button>
          <span>
            {lines.length > 0
              ? `目前進度：${currentIndex + 1} / ${lines.length}`
              : '尚未載入字幕'}
          </span>
        </div>

        <div className="input-group transcription-panel">
          <label>即時語音辨識（雲端）</label>
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
            <span>
              輸出：{transcription.isFinal ? '最終稿' : '即時草稿'}
            </span>
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
          <div
            className={`viewer-preview-box ${
              displayEnabled ? '' : 'viewer-muted'
            } ${
              lines[currentIndex]?.type === 'direction' ? 'viewer-direction' : ''
            }`}
          >
            {lines.length
              ? lines[currentIndex]
                ? lines[currentIndex].type === 'direction'
                  ? `【舞台指示】${lines[currentIndex].text || '—'}`
                  : lines[currentIndex].text || '—'
                : '—'
              : '尚未載入字幕'}
          </div>
          <div className="control-instructions">
            • Enter/點擊字幕可立即跳行
            <br />
            • 方向鍵 ↑ ↓ 切換字幕
            <br />
            • Command + F 搜尋台詞，點擊即可跳轉
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
      </section>

      <section className="script-panel">
        <header className="script-header">
          <h2>劇本字幕清單</h2>
          <small>右側內容可直接編輯，雙擊或點擊即跳轉</small>
        </header>

        <div className="script-list">
          {lines.length === 0 && (
            <p style={{ color: '#94a3b8', textAlign: 'center' }}>
              尚未載入字幕，請先上傳劇本或手動輸入。
            </p>
          )}
          {lines.map((line, index) => {
            const lineText =
              typeof line === 'string' ? line : line?.text ?? ''
            const lineType =
              typeof line === 'object' && line?.type === 'direction'
                ? 'direction'
                : 'dialogue'

            return (
              <div
                key={`${index}-${lineText.slice(0, 10)}`}
                className={`script-line ${
                  currentIndex === index ? 'active' : ''
                } ${lineType === 'direction' ? 'direction' : ''}`}
                onClick={() => handleLineClick(index)}
              >
                {typeof line === 'object' && (
                  <div className="script-line-header">
                    <span
                      className={`script-line-type ${
                        lineType === 'direction'
                          ? 'type-direction'
                          : 'type-dialogue'
                      }`}
                    >
                      {lineType === 'direction' ? '舞台指示' : '台詞'}
                    </span>
                    <div className="script-line-actions">
                      <button
                        type="button"
                        className="line-action toggle"
                        onClick={(event) => handleToggleLineType(event, index)}
                      >
                        {lineType === 'direction' ? '設為台詞' : '設為舞台指示'}
                      </button>
                      <button
                        type="button"
                        className="line-action delete"
                        onClick={(event) => handleDeleteLine(event, index)}
                      >
                        刪除
                      </button>
                    </div>
                  </div>
                )}
                <div
                  ref={(node) => {
                    if (node) {
                      lineRefs.current[index] = node
                    } else {
                      delete lineRefs.current[index]
                    }
                  }}
                  className={`script-line-text ${
                    editingIndex === index ? 'editing' : ''
                  }`}
                  contentEditable={editingIndex === index}
                  suppressContentEditableWarning
                  onBlur={(event) => handleLineBlur(event, index)}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    handleLineDoubleClick(index)
                  }}
                  onKeyDown={(event) => handleLineKeyDown(event, index)}
                >
                  {editingIndex === index ? lineText : lineText || '（空白）'}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}

export default ControlPage
