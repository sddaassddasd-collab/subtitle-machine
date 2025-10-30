import { Navigate, Route, Routes } from 'react-router-dom'
import './App.css'
import ControlPage from './pages/ControlPage'
import HomePage from './pages/HomePage'
import ViewerPage from './pages/ViewerPage'

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/control" element={<ControlPage />} />
      <Route path="/viewer" element={<ViewerPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
