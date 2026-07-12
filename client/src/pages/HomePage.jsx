import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const HomePage = () => {
  const navigate = useNavigate()
  const backupInputRef = useRef(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [sharedPassword, setSharedPassword] = useState('')
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
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
        throw new Error(data.error || '匯入工作區備份失敗')
      }

      setNotice('工作區備份已匯入')
      navigate('/control')
    } catch (importError) {
      setError(importError.message || '匯入工作區備份失敗')
    } finally {
      setImporting(false)
      if (backupInputRef.current) {
        backupInputRef.current.value = ''
      }
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
            <h1>全域字幕工作區</h1>
            <p>目前所有控制頁都會連到同一份字幕狀態，不再切換場次。</p>
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
            <button type="button" onClick={() => navigate('/control')}>
              進入控制端
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

        <section className="dashboard-settings-card">
          <div>
            <h2>工作區備份</h2>
            <p>
              匯入備份會直接覆蓋目前這份全域工作區，包含語言、儲存格、字幕內容與投影設定。
            </p>
          </div>
          <div className="dashboard-actions">
            <button
              type="button"
              className="subtle-button"
              onClick={() => backupInputRef.current?.click()}
              disabled={importing}
            >
              {importing ? '匯入中…' : '匯入工作區備份 JSON'}
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
