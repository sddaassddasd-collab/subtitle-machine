import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'

const ViewerEntryPage = () => {
  const { viewerAlias } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const query = useMemo(
    () => new URLSearchParams(location.search),
    [location.search],
  )
  const resolvedViewerAlias = viewerAlias || query.get('viewerAlias') || ''
  const [error, setError] = useState('')

  useEffect(() => {
    if (!resolvedViewerAlias) {
      setError('缺少檢視端入口名稱')
      return
    }

    let cancelled = false

    const resolveViewerEntry = async () => {
      try {
        const response = await fetch(
          `/api/viewer-entry/${encodeURIComponent(resolvedViewerAlias)}`,
        )
        const data = await response.json().catch(() => ({}))
        if (!response.ok) {
          throw new Error(data?.error || data?.message || '找不到檢視端入口')
        }

        const redirectPath =
          typeof data?.redirectPath === 'string' && data.redirectPath
            ? data.redirectPath
            : ''
        if (!redirectPath) {
          throw new Error('找不到檢視端入口')
        }

        if (!cancelled) {
          navigate(redirectPath, { replace: true })
        }
      } catch (resolveError) {
        if (!cancelled) {
          setError(resolveError.message || '找不到檢視端入口')
        }
      }
    }

    void resolveViewerEntry()

    return () => {
      cancelled = true
    }
  }, [navigate, resolvedViewerAlias])

  return (
    <div className="page">
      <div className="home-intro">
        <h1>{error ? '檢視端入口無法使用' : '正在進入檢視端…'}</h1>
        <p>
          {error
            ? error
            : '系統正在把你導向目前有效的場次，稍候會自動進入。'}
        </p>
      </div>
    </div>
  )
}

export default ViewerEntryPage
