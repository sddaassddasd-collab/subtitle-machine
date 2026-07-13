import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const HomePage = () => {
  const navigate = useNavigate()
  const backupInputRef = useRef(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [sharedPassword, setSharedPassword] = useState('')
  const [user, setUser] = useState(null)
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [newWorkspaceTitle, setNewWorkspaceTitle] = useState('')
  const [authLoading, setAuthLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const [unlockingSharedAccess, setUnlockingSharedAccess] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const response = await fetch('/api/auth/me')
        const data = await response.json().catch(() => ({}))
        if (cancelled) return
        if (data?.user) {
          setUser(data.user)
        }
      } catch {
        // Keep locked state when bootstrap fails.
      } finally {
        if (!cancelled) {
          setAuthLoading(false)
        }
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  const loadSessions = async () => {
    setSessionsLoading(true)
    setError('')

    try {
      const response = await fetch('/api/sessions')
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '無法載入節目')
      }
      setSessions(Array.isArray(data?.sessions) ? data.sessions : [])
    } catch (loadError) {
      setError(loadError.message || '無法載入節目')
    } finally {
      setSessionsLoading(false)
    }
  }

  useEffect(() => {
    if (!user) {
      setSessions([])
      return
    }

    void loadSessions()
  }, [user])

  const handleLoginSubmit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setNotice('')

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          password,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '登入失敗')
      }

      setUser(data?.user || null)
      setUsername('')
      setPassword('')
    } catch (accessError) {
      setError(accessError.message || '登入失敗')
    } finally {
      setSubmitting(false)
    }
  }

  const handleSharedAccessSubmit = async (event) => {
    event.preventDefault()
    setUnlockingSharedAccess(true)
    setError('')
    setNotice('')

    try {
      const response = await fetch('/api/access/unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password: sharedPassword,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '共用密碼錯誤')
      }

      setUser(data?.user || null)
      setSharedPassword('')
    } catch (accessError) {
      setError(accessError.message || '共用密碼錯誤')
    } finally {
      setUnlockingSharedAccess(false)
    }
  }

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
      })
    } finally {
      setUser(null)
      setSessions([])
      setUsername('')
      setPassword('')
      setSharedPassword('')
      setError('')
      setNotice('')
    }
  }

  const handleImportWorkspaceBackup = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    setImporting(true)
    setError('')
    setNotice('')

    try {
      const content = await file.text()
      const parsed = JSON.parse(content)
      const response = await fetch('/api/session/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parsed),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '匯入節目備份失敗')
      }

      setNotice('節目備份已匯入')
      const nextSessionId = data?.sessionId || data?.session?.id
      if (nextSessionId) {
        navigate(`/control/${encodeURIComponent(nextSessionId)}`)
      } else {
        await loadSessions()
      }
    } catch (importError) {
      setError(importError.message || '匯入節目備份失敗')
    } finally {
      setImporting(false)
      if (backupInputRef.current) {
        backupInputRef.current.value = ''
      }
    }
  }

  const handleCreateWorkspace = async (event) => {
    event.preventDefault()
    setCreatingWorkspace(true)
    setError('')
    setNotice('')

    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: newWorkspaceTitle,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '建立節目失敗')
      }

      const nextSessionId = data?.sessionId || data?.session?.id
      setNewWorkspaceTitle('')
      if (nextSessionId) {
        navigate(`/control/${encodeURIComponent(nextSessionId)}`)
      } else {
        await loadSessions()
        setNotice('節目已建立')
      }
    } catch (createError) {
      setError(createError.message || '建立節目失敗')
    } finally {
      setCreatingWorkspace(false)
    }
  }

  if (authLoading) {
    return (
      <div className="page">
        <div className="home-intro">載入中…</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="page">
        <div className="home-shell">
          <section className="home-hero-card">
            <div>
              <h1>劇場字幕機</h1>
              <p>請使用管理員建立的帳號登入控制端。</p>
            </div>
            <div className="info-panel compact">
              <strong>封閉式帳號系統</strong>
              <span>公開註冊已關閉，新帳號需由管理員在後台建立。</span>
            </div>
            <form className="auth-form" onSubmit={handleLoginSubmit}>
              <label htmlFor="account-username">帳號</label>
              <input
                id="account-username"
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="輸入帳號"
                autoComplete="username"
              />
              <label htmlFor="account-password">密碼</label>
              <input
                id="account-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="輸入密碼"
                autoComplete="current-password"
              />
              <button type="submit" disabled={submitting}>
                {submitting ? '登入中…' : '登入'}
              </button>
            </form>
            <form className="auth-form secondary-auth-form" onSubmit={handleSharedAccessSubmit}>
              <label htmlFor="shared-password">共用控制密碼</label>
              <div className="inline-auth-row">
                <input
                  id="shared-password"
                  type="password"
                  value={sharedPassword}
                  onChange={(event) => setSharedPassword(event.target.value)}
                  placeholder="臨時進入控制端"
                />
                <button
                  type="submit"
                  className="subtle-button"
                  disabled={unlockingSharedAccess}
                >
                  {unlockingSharedAccess ? '驗證中…' : '共用進入'}
                </button>
              </div>
            </form>
            {notice && <div className="status-success">{notice}</div>}
            {error && <div className="status-error">{error}</div>}
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="dashboard-shell">
        <section className="dashboard-header-card">
          <div>
            <h1>字幕節目</h1>
            <p>不同劇組、案子與使用者會使用各自的節目，字幕資料互不影響。</p>
          </div>
          <div className="dashboard-actions">
            {user.role === 'admin' && (
              <button
                type="button"
                className="subtle-button"
                onClick={() => navigate('/admin')}
              >
                管理帳號
              </button>
            )}
            <button
              type="button"
              className="subtle-button"
              onClick={handleLogout}
            >
              離開系統
            </button>
          </div>
        </section>

        <section className="dashboard-settings-card">
          <div>
            <h2>建立節目</h2>
            <p>每個節目都有自己的場次、字幕、語言、角色、投影設定與分享連結。</p>
          </div>
          <form className="workspace-create-form" onSubmit={handleCreateWorkspace}>
            <input
              type="text"
              value={newWorkspaceTitle}
              onChange={(event) => setNewWorkspaceTitle(event.target.value)}
              placeholder="例如：劇組 A / 正式演出 / 彩排"
            />
            <button type="submit" disabled={creatingWorkspace}>
              {creatingWorkspace ? '建立中…' : '建立並進入'}
            </button>
          </form>
        </section>

        <section className="session-grid">
          {sessionsLoading && (
            <article className="session-card empty">載入節目中…</article>
          )}
          {!sessionsLoading && sessions.length === 0 && (
            <article className="session-card empty">
              尚未建立節目，請先建立第一個劇組或案子的節目。
            </article>
          )}
          {!sessionsLoading &&
            sessions.map((session) => (
              <article key={session.id} className="session-card">
                <div className="session-card-head">
                  <div>
                    <h2>{session.title || '未命名節目'}</h2>
                    <p>
                      更新時間：
                      {session.updatedAt
                        ? new Date(session.updatedAt).toLocaleString('zh-TW', {
                            hour12: false,
                          })
                        : '未知'}
                    </p>
                  </div>
                  <span
                    className={`session-state-badge ${
                      session.status === 'ended' ? 'ended' : 'active'
                    }`}
                  >
                    {session.status === 'ended' ? '已結束' : '使用中'}
                  </span>
                </div>
                <div className="session-card-meta">
                  <span>{Array.isArray(session.cells) ? session.cells.length : 0} 個場次</span>
                  <span>{Array.isArray(session.languages) ? session.languages.length : 0} 種語言</span>
                </div>
                <div className="session-card-actions">
                  <button
                    type="button"
                    onClick={() =>
                      navigate(`/control/${encodeURIComponent(session.id)}`)
                    }
                  >
                    進入控制端
                  </button>
                </div>
              </article>
            ))}
        </section>

        <section className="dashboard-settings-card">
          <div>
            <h2>節目備份</h2>
            <p>
              匯入備份會建立一份新的節目副本，包含語言、角色、場次、字幕內容與投影設定。
            </p>
          </div>
          <div className="dashboard-actions">
            <button
              type="button"
              className="subtle-button"
              onClick={() => backupInputRef.current?.click()}
              disabled={importing}
            >
              {importing ? '匯入中…' : '匯入節目備份 JSON'}
            </button>
            <input
              ref={backupInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              onChange={handleImportWorkspaceBackup}
            />
          </div>
        </section>

        {notice && <div className="status-success">{notice}</div>}
        {error && <div className="status-error">{error}</div>}
      </div>
    </div>
  )
}

export default HomePage
