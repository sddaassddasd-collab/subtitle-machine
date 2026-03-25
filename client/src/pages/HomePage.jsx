import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const HomePage = () => {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [user, setUser] = useState(null)
  const [sessions, setSessions] = useState([])
  const [authLoading, setAuthLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const loadSessions = async () => {
    const response = await fetch('/api/sessions')
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(data.error || '無法載入場次列表')
    }
    setSessions(Array.isArray(data?.sessions) ? data.sessions : [])
  }

  const syncUserState = async (nextUser) => {
    setUser(nextUser || null)
    if (nextUser) {
      await loadSessions()
      return
    }
    setSessions([])
  }

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const response = await fetch('/api/auth/me')
        const data = await response.json().catch(() => ({}))
        if (cancelled) return
        if (data?.user) {
          setUser(data.user)
          const sessionResponse = await fetch('/api/sessions')
          const sessionData = await sessionResponse.json().catch(() => ({}))
          if (!cancelled && sessionResponse.ok) {
            setSessions(
              Array.isArray(sessionData?.sessions) ? sessionData.sessions : [],
            )
          }
        }
      } catch {
        // Keep locked state when bootstrap fails.
      } finally {
        if (!cancelled) {
          setAuthLoading(false)
        }
      }
    }

    bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  const handleAccessSubmit = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    setNotice('')

    try {
      const response = await fetch('/api/access/unlock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          password,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '密碼錯誤')
      }

      await syncUserState(data?.user || null)
      setPassword('')
    } catch (accessError) {
      setError(accessError.message || '密碼錯誤')
    } finally {
      setSubmitting(false)
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
      setPassword('')
      setError('')
      setNotice('')
    }
  }

  const handleCreateSession = async () => {
    setCreating(true)
    setError('')
    setNotice('')

    try {
      const response = await fetch('/api/session', {
        method: 'POST',
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '建立場次失敗')
      }

      const nextSessionId = data?.sessionId || data?.session?.id
      if (!nextSessionId) {
        throw new Error('建立場次失敗')
      }

      await loadSessions()
      navigate(`/control?session=${encodeURIComponent(nextSessionId)}`)
    } catch (createError) {
      setError(createError.message || '建立場次失敗')
    } finally {
      setCreating(false)
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
              <p>登入系統已暫時隱藏，目前改為共用密碼進入控制端。</p>
            </div>
            <div className="info-panel compact">
              <strong>進入後即可查看既有場次或建立新場次</strong>
              <span>檢視端與投影端連結仍會照常由控制端產生。</span>
            </div>
            <form className="auth-form" onSubmit={handleAccessSubmit}>
              <label htmlFor="shared-password">密碼</label>
              <input
                id="shared-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="輸入控制密碼"
              />
              <button type="submit" disabled={submitting}>
                {submitting ? '驗證中…' : '進入系統'}
              </button>
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
            <h1>我的字幕系統</h1>
            <p>目前以共用密碼模式進入，可直接管理所有場次。</p>
          </div>
          <div className="dashboard-actions">
            <button onClick={handleCreateSession} disabled={creating}>
              {creating ? '建立中…' : '建立新場次'}
            </button>
            <button
              type="button"
              className="subtle-button"
              onClick={handleLogout}
            >
              離開系統
            </button>
          </div>
        </section>

        {notice && <div className="status-success">{notice}</div>}
        {error && <div className="status-error">{error}</div>}

        <section className="session-grid">
          {sessions.length === 0 && (
            <div className="session-card empty">
              <p>目前還沒有場次。建立新場次後，系統會產生 viewer 網址、projector 網址與 QR code。</p>
            </div>
          )}

          {sessions.map((session) => (
            <article key={session.id} className="session-card">
              <div className="session-card-head">
                <div>
                  <h2>{session.title || '未命名場次'}</h2>
                  <p>
                    建立時間：
                    {session.createdAt
                      ? ` ${new Date(session.createdAt).toLocaleString()}`
                      : ' 未知'}
                  </p>
                </div>
                <span className={`session-badge ${session.status || 'active'}`}>
                  {session.status === 'ended' ? '已結束' : '進行中'}
                </span>
              </div>

              <div className="session-card-meta">
                <span>{session.cells?.length || 0} 個儲存格</span>
                <span>{session.languages?.length || 1} 種語言</span>
              </div>

              <div className="session-card-actions">
                <button
                  type="button"
                  onClick={() =>
                    navigate(`/control?session=${encodeURIComponent(session.id)}`)
                  }
                >
                  進入控制端
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}

export default HomePage
