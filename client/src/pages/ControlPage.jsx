import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { io } from 'socket.io-client'

const DEFAULT_SESSION_ID = 'default'
const ACCESS_CODE = '20141017'

const storageKeys = {
  apiKey: 'subtitleMachineApiKey',
  rememberKey: 'subtitleMachineRememberKey',
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
    const fetchSession = async () => {
      try {
        const response = await fetch(`/api/session/${sessionId}`)
        if (!response.ok) {
          throw new Error()
        }

        const data = await response.json()
        if (!disposed) {
          setLines(Array.isArray(data.lines) ? data.lines : [])
          setCurrentIndex(
            Number.isInteger(data.currentIndex) ? data.currentIndex : 0,
          )
          setDisplayEnabled(
            typeof data.displayEnabled === 'boolean'
              ? data.displayEnabled
              : true,
          )
        }
      } catch {
        setStatus({
          kind: 'error',
          message: '找不到場次或無法載入資料',
        })
      }
    }

    fetchSession()
    return () => {
      disposed = true
    }
  }, [sessionId, authenticated])

  useEffect(() => {
    if (!authenticated || !sessionId) return

    const socket = io()
    socketRef.current = socket
    socket.emit('join', { sessionId, role: 'control' })

    socket.on('control:update', (payload) => {
      setLines(Array.isArray(payload.lines) ? payload.lines : [])
      setCurrentIndex(
        Number.isInteger(payload.currentIndex) ? payload.currentIndex : 0,
      )
      setDisplayEnabled(
        typeof payload.displayEnabled === 'boolean'
          ? payload.displayEnabled
          : true,
      )
    })

    return () => {
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
    const node = lineRefs.current[index]
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

    const preRange = range.cloneRange()
    preRange.selectNodeContents(node)
    preRange.setEnd(range.endContainer, range.endOffset)
    const caretOffset = preRange.toString().length

    const currentLine = lines[index]
    const currentType =
      typeof currentLine === 'object' && currentLine?.type === 'direction'
        ? 'direction'
        : 'dialogue'

    const currentTextContent = node.textContent ?? ''
    const beforeRaw = currentTextContent.slice(0, caretOffset)
    const afterRaw = currentTextContent.slice(caretOffset)
    const beforeText = beforeRaw.trim()
    const afterText = afterRaw.trim()

    if (!beforeText) {
      return
    }

    event.preventDefault()

    if (!afterText) {
      skipBlurRef.current.add(index)

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
