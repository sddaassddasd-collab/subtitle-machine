import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

const ROLE_OPTIONS = [
  { value: 'admin', label: '管理員' },
  { value: 'operator', label: '操作員' },
  { value: 'viewer', label: '檢視帳號' },
]

function formatDateTime(value) {
  if (!value) return '未知'
  try {
    return new Date(value).toLocaleString()
  } catch {
    return '未知'
  }
}

const AdminPage = () => {
  const navigate = useNavigate()
  const [currentUser, setCurrentUser] = useState(null)
  const [users, setUsers] = useState([])
  const [authLoading, setAuthLoading] = useState(true)
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [savingUserId, setSavingUserId] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [passwordDrafts, setPasswordDrafts] = useState({})

  const loadUsers = async () => {
    setLoadingUsers(true)
    setError('')

    try {
      const response = await fetch('/api/admin/users')
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '無法載入帳號列表')
      }
      setUsers(Array.isArray(data?.users) ? data.users : [])
    } catch (loadError) {
      setError(loadError.message || '無法載入帳號列表')
    } finally {
      setLoadingUsers(false)
    }
  }

  useEffect(() => {
    let cancelled = false

    const bootstrap = async () => {
      try {
        const response = await fetch('/api/auth/me')
        const data = await response.json().catch(() => ({}))
        if (cancelled) return
        if (!data?.user) {
          navigate('/', { replace: true })
          return
        }

        setCurrentUser(data.user)
        if (data.user.role === 'admin') {
          const usersResponse = await fetch('/api/admin/users')
          const usersData = await usersResponse.json().catch(() => ({}))
          if (cancelled) return
          if (!usersResponse.ok) {
            setError(usersData.error || '無法載入帳號列表')
          } else {
            setUsers(Array.isArray(usersData?.users) ? usersData.users : [])
          }
        }
      } catch {
        if (!cancelled) {
          navigate('/', { replace: true })
        }
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
  }, [navigate])

  const patchUser = async (userId, payload, successMessage) => {
    setSavingUserId(userId)
    setError('')
    setNotice('')

    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '更新帳號失敗')
      }

      setUsers((prev) =>
        prev.map((user) => (user.id === userId ? data.user || user : user)),
      )
      setNotice(successMessage)
      if (payload.newPassword) {
        setPasswordDrafts((prev) => ({ ...prev, [userId]: '' }))
      }
    } catch (patchError) {
      setError(patchError.message || '更新帳號失敗')
    } finally {
      setSavingUserId('')
    }
  }

  const handleDeleteUser = async (targetUser) => {
    if (!window.confirm(`確定要刪除帳號「${targetUser.username}」嗎？`)) {
      return
    }

    setSavingUserId(targetUser.id)
    setError('')
    setNotice('')

    try {
      const response = await fetch(
        `/api/admin/users/${encodeURIComponent(targetUser.id)}`,
        {
          method: 'DELETE',
        },
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data.error || '刪除帳號失敗')
      }

      setUsers((prev) => prev.filter((user) => user.id !== targetUser.id))
      setNotice(
        `已刪除帳號，並移除 ${data?.removedSessionCount ?? 0} 個場次`,
      )
    } catch (deleteError) {
      setError(deleteError.message || '刪除帳號失敗')
    } finally {
      setSavingUserId('')
    }
  }

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
      })
    } finally {
      navigate('/', { replace: true })
    }
  }

  if (authLoading) {
    return (
      <div className="page">
        <div className="home-intro">載入中…</div>
      </div>
    )
  }

  if (!currentUser || currentUser.role !== 'admin') {
    return (
      <div className="page">
        <div className="home-shell">
          <section className="home-hero-card">
            <h1>管理員後台</h1>
            <p>目前帳號沒有管理員權限。</p>
            <div className="dashboard-actions">
              <button type="button" onClick={() => navigate('/')}>
                返回首頁
              </button>
            </div>
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
            <h1>管理員後台</h1>
            <p>帳號列表、停用、刪除、改密碼與權限分級都集中在這裡。</p>
          </div>
          <div className="dashboard-actions">
            <button type="button" className="subtle-button" onClick={() => navigate('/')}>
              返回首頁
            </button>
            <button type="button" className="subtle-button" onClick={loadUsers} disabled={loadingUsers}>
              {loadingUsers ? '重新整理中…' : '重新整理'}
            </button>
            <button type="button" className="subtle-button" onClick={handleLogout}>
              登出
            </button>
          </div>
        </section>

        {notice && <div className="status-success">{notice}</div>}
        {error && <div className="status-error">{error}</div>}

        <section className="admin-grid">
          {users.map((account) => (
            <article key={account.id} className="admin-user-card">
              <div className="admin-user-head">
                <div>
                  <h2>{account.username}</h2>
                  <p>建立時間：{formatDateTime(account.createdAt)}</p>
                </div>
                <div className="account-summary-grid">
                  <span className={`role-badge ${account.role || 'viewer'}`}>
                    {ROLE_OPTIONS.find((item) => item.value === account.role)?.label ||
                      account.role}
                  </span>
                  <span
                    className={`session-state-badge ${
                      account.disabled ? 'ended' : 'active'
                    }`}
                  >
                    {account.disabled ? '已停用' : '啟用中'}
                  </span>
                </div>
              </div>

              <div className="admin-user-meta">
                <span>帳號 ID：{account.id}</span>
                <span>場次數：{account.sessionCount || 0}</span>
                <span>{account.canManageSessions ? '可管理場次' : '不可管理場次'}</span>
              </div>

              {account.passwordReset && (
                <div className="info-panel compact">
                  <strong>有進行中的忘記密碼重設</strong>
                  <span>到期時間：{formatDateTime(account.passwordReset.expiresAt)}</span>
                  <button
                    type="button"
                    className="subtle-button"
                    onClick={() =>
                      patchUser(
                        account.id,
                        { clearPasswordReset: true },
                        `已清除 ${account.username} 的重設申請`,
                      )
                    }
                    disabled={savingUserId === account.id}
                  >
                    清除申請
                  </button>
                </div>
              )}

              <div className="admin-user-actions">
                <label className="admin-inline-field">
                  <span>權限</span>
                  <select
                    value={account.role || 'viewer'}
                    onChange={(event) =>
                      patchUser(
                        account.id,
                        { role: event.target.value },
                        `已更新 ${account.username} 的權限`,
                      )
                    }
                    disabled={savingUserId === account.id || account.id === currentUser.id}
                  >
                    {ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className="subtle-button"
                  onClick={() =>
                    patchUser(
                      account.id,
                      { disabled: !account.disabled },
                      account.disabled
                        ? `已啟用 ${account.username}`
                        : `已停用 ${account.username}`,
                    )
                  }
                  disabled={savingUserId === account.id || account.id === currentUser.id}
                >
                  {account.disabled ? '啟用帳號' : '停用帳號'}
                </button>
              </div>

              <div className="admin-password-row">
                <input
                  type="password"
                  value={passwordDrafts[account.id] || ''}
                  onChange={(event) =>
                    setPasswordDrafts((prev) => ({
                      ...prev,
                      [account.id]: event.target.value,
                    }))
                  }
                  placeholder="輸入新密碼以直接重設"
                />
                <button
                  type="button"
                  className="subtle-button"
                  onClick={() =>
                    patchUser(
                      account.id,
                      { newPassword: passwordDrafts[account.id] || '' },
                      `已更新 ${account.username} 的密碼`,
                    )
                  }
                  disabled={savingUserId === account.id || account.id === currentUser.id}
                >
                  直接改密碼
                </button>
                <button
                  type="button"
                  className="subtle-button danger-button"
                  onClick={() => handleDeleteUser(account)}
                  disabled={savingUserId === account.id || account.id === currentUser.id}
                >
                  刪除帳號
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}

export default AdminPage
