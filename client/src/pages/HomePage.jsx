import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const AUTH_MODES = {
  LOGIN: 'login',
  REGISTER: 'register',
  FORGOT: 'forgot',
}

const ROLE_LABELS = {
  admin: '管理員',
  operator: '操作員',
  viewer: '檢視帳號',
}

const emptyAuthForm = {
  username: '',
  password: '',
}

const emptyPasswordForm = {
  currentPassword: '',
  newPassword: '',
}

const HomePage = () => {
  const navigate = useNavigate()
  const [mode, setMode] = useState(AUTH_MODES.LOGIN)
  const [authForm, setAuthForm] = useState(emptyAuthForm)
  const [passwordForm, setPasswordForm] = useState(emptyPasswordForm)
  const [user, setUser] = useState(null)
  const [sessions, setSessions] = useState([])
  const [authLoading, setAuthLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [creating, setCreating] = useState(false)
  const [changingPassword, setChangingPassword] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authNotice, setAuthNotice] = useState('')
  const [accountError, setAccountError] = useState('')
  const [accountNotice, setAccountNotice] = useState('')

  const loadSessions = async () => {
    const response = await fetch('/api/sessions')
    if (!response.ok) {
      throw new Error('無法載入場次列表')
    }
    const data = await response.json()
    setSessions(Array.isArray(data?.sessions) ? data.sessions : [])
  }

  const syncUserState = async (nextUser) => {
    setUser(nextUser || null)
    if (nextUser?.canManageSessions) {
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

          if (data.user.canManageSessions) {
            const sessionResponse = await fetch('/api/sessions')
            const sessionData = await sessionResponse.json().catch(() => ({}))
            if (!cancelled && sessionResponse.ok) {
              setSessions(
                Array.isArray(sessionData?.sessions) ? sessionData.sessions : [],
              )
            }
          }
        }
      } catch {
        // Ignore bootstrap errors and keep unauthenticated state.
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

  const handleModeChange = (nextMode) => {
    setMode(nextMode)
    setAuthError('')
    setAuthNotice('')
  }

  const handleAuthSubmit = async (event) => {
    event.preventDefault()
    setAuthError('')
    setAuthNotice('')
    setSubmitting(true)

    try {
      const response = await fetch(
        mode === AUTH_MODES.REGISTER ? '/api/auth/register' : '/api/auth/login',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            username: authForm.username,
            password: authForm.password,
          }),
        },
      )

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '登入失敗')
      }

      await syncUserState(data.user || null)
      setAuthForm(emptyAuthForm)
    } catch (authSubmitError) {
      setAuthError(authSubmitError.message || '登入失敗')
    } finally {
      setSubmitting(false)
    }
  }

  const handleForgotPasswordRequest = async (event) => {
    event.preventDefault()
    setAuthError('')
    setAuthNotice('')
    setSubmitting(true)

    try {
      const response = await fetch('/api/auth/forgot-password/request', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username: authForm.username,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '無法送出申請')
      }

      setAuthNotice(data.message || '已送出申請')
    } catch (forgotError) {
      setAuthError(forgotError.message || '無法送出申請')
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
      setAuthForm(emptyAuthForm)
      setPasswordForm(emptyPasswordForm)
      setMode(AUTH_MODES.LOGIN)
      setAuthError('')
      setAuthNotice('')
      setAccountError('')
      setAccountNotice('')
    }
  }

  const handleCreateSession = async () => {
    if (!user?.canManageSessions) {
      setAccountError('目前帳號權限無法建立控制端場次')
      return
    }

    setCreating(true)
    setAccountError('')

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
      setAccountError(createError.message || '建立場次失敗')
    } finally {
      setCreating(false)
    }
  }

  const handleChangePassword = async (event) => {
    event.preventDefault()
    setAccountError('')
    setAccountNotice('')
    setChangingPassword(true)

    try {
      const response = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(passwordForm),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '修改密碼失敗')
      }

      setPasswordForm(emptyPasswordForm)
      setAccountNotice('密碼已更新')
      if (data?.user) {
        setUser(data.user)
      }
    } catch (changeError) {
      setAccountError(changeError.message || '修改密碼失敗')
    } finally {
      setChangingPassword(false)
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
              <p>
                使用者登入後會拿到自己的字幕場次。管理員可進入後台管理帳號、停用使用者、
                調整權限與刪除帳號。
              </p>
            </div>
            <div className="mode-switch">
              <button
                type="button"
                className={mode === AUTH_MODES.LOGIN ? 'active' : ''}
                onClick={() => handleModeChange(AUTH_MODES.LOGIN)}
              >
                登入
              </button>
              <button
                type="button"
                className={mode === AUTH_MODES.REGISTER ? 'active' : ''}
                onClick={() => handleModeChange(AUTH_MODES.REGISTER)}
              >
                註冊
              </button>
              <button
                type="button"
                className={mode === AUTH_MODES.FORGOT ? 'active' : ''}
                onClick={() => handleModeChange(AUTH_MODES.FORGOT)}
              >
                忘記密碼
              </button>
            </div>

            {(mode === AUTH_MODES.LOGIN || mode === AUTH_MODES.REGISTER) && (
              <form className="auth-form" onSubmit={handleAuthSubmit}>
                <label htmlFor="username">帳號</label>
                <input
                  id="username"
                  type="text"
                  value={authForm.username}
                  onChange={(event) =>
                    setAuthForm((prev) => ({ ...prev, username: event.target.value }))
                  }
                  placeholder="輸入帳號"
                />
                <label htmlFor="password">密碼</label>
                <input
                  id="password"
                  type="password"
                  value={authForm.password}
                  onChange={(event) =>
                    setAuthForm((prev) => ({ ...prev, password: event.target.value }))
                  }
                  placeholder="至少 6 個字"
                />
                <button type="submit" disabled={submitting}>
                  {submitting
                    ? mode === AUTH_MODES.REGISTER
                      ? '註冊中…'
                      : '登入中…'
                    : mode === AUTH_MODES.REGISTER
                      ? '建立帳號'
                      : '登入'}
                </button>
              </form>
            )}

            {mode === AUTH_MODES.FORGOT && (
              <form className="auth-form" onSubmit={handleForgotPasswordRequest}>
                <label htmlFor="forgot-username">帳號</label>
                <input
                  id="forgot-username"
                  type="text"
                  value={authForm.username}
                  onChange={(event) =>
                    setAuthForm((prev) => ({ ...prev, username: event.target.value }))
                  }
                  placeholder="輸入帳號以送出重設申請"
                />
                <div className="info-panel compact">
                  <strong>送出後不會直接顯示重設碼</strong>
                  <span>管理員會在後台看到申請並協助你重設密碼。</span>
                </div>
                <button type="submit" disabled={submitting}>
                  {submitting ? '送出中…' : '送出重設申請'}
                </button>
              </form>
            )}
            {authNotice && <div className="status-success">{authNotice}</div>}
            {authError && <div className="status-error">{authError}</div>}
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
            <p>
              目前登入帳號：<strong>{user.username}</strong>
            </p>
            <div className="account-summary-grid">
              <span className={`role-badge ${user.role || 'viewer'}`}>
                {ROLE_LABELS[user.role] || user.role}
              </span>
              <span className="session-state-badge active">
                {user.canManageSessions ? '可管理場次' : '僅能登入'}
              </span>
            </div>
            {!user.canManageSessions && (
              <p className="permission-note">
                此帳號目前無法建立控制端場次。請由管理員把權限調整為操作員或管理員。
              </p>
            )}
          </div>
          <div className="dashboard-actions">
            {user.role === 'admin' && (
              <button
                type="button"
                className="subtle-button"
                onClick={() => navigate('/admin')}
              >
                管理員後台
              </button>
            )}
            <button onClick={handleCreateSession} disabled={creating || !user.canManageSessions}>
              {creating ? '建立中…' : '建立新場次'}
            </button>
            <button
              type="button"
              className="subtle-button"
              onClick={handleLogout}
            >
              登出
            </button>
          </div>
        </section>

        <section className="dashboard-settings-card">
          <div className="section-header-inline">
            <h2>帳號設定</h2>
            <span>修改目前登入帳號的密碼</span>
          </div>
          <form className="account-form-grid" onSubmit={handleChangePassword}>
            <input
              type="password"
              value={passwordForm.currentPassword}
              onChange={(event) =>
                setPasswordForm((prev) => ({
                  ...prev,
                  currentPassword: event.target.value,
                }))
              }
              placeholder="目前密碼"
            />
            <input
              type="password"
              value={passwordForm.newPassword}
              onChange={(event) =>
                setPasswordForm((prev) => ({
                  ...prev,
                  newPassword: event.target.value,
                }))
              }
              placeholder="新密碼"
            />
            <button type="submit" disabled={changingPassword}>
              {changingPassword ? '更新中…' : '更新密碼'}
            </button>
          </form>
          {accountNotice && <div className="status-success">{accountNotice}</div>}
          {accountError && <div className="status-error">{accountError}</div>}
        </section>

        {user.canManageSessions ? (
          <section className="session-grid">
            {sessions.length === 0 && (
              <div className="session-card empty">
                <p>目前還沒有場次。建立新場次後，系統會產生獨立 viewer 網址與 QR code。</p>
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
        ) : (
          <section className="session-grid">
            <div className="session-card empty">
              <p>這個帳號可以登入，但目前沒有控制場次的權限。</p>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export default HomePage
