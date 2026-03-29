import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import AdminPage from './pages/AdminPage'
import ControlPage from './pages/ControlPage'
import HomePage from './pages/HomePage'
import ProjectorPage from './pages/ProjectorPage'
import ViewerEntryPage from './pages/ViewerEntryPage'
import ViewerPage from './pages/ViewerPage'

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/admin" element={<AdminPage />} />
      <Route path="/control" element={<ControlPage />} />
      <Route path="/projector/:projectorToken" element={<ProjectorPage />} />
      <Route path="/projector" element={<ProjectorPage />} />
      <Route path="/v/:viewerAlias" element={<ViewerEntryPage />} />
      <Route path="/viewer/:viewerToken" element={<ViewerPage />} />
      <Route path="/viewer" element={<ViewerPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
