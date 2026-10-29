import { Navigate, useLocation, useParams } from 'react-router-dom'

// Keep printed and bookmarked prompter URLs working through the shared display.
export default function PrompterPage() {
  const { viewerToken } = useParams()
  const location = useLocation()
  const query = new URLSearchParams(location.search)
  const token = viewerToken || query.get('viewer') || ''
  query.delete('viewer')
  query.set('mode', 'prompter')
  return <Navigate replace to={`/viewer${token ? `/${encodeURIComponent(token)}` : ''}?${query}`} />
}
