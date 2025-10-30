import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const HomePage = () => {
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const createSession = async () => {
    try {
      setError('')
      setCreating(true)
      const response = await fetch('/api/session', {
        method: 'POST',
      })

      if (!response.ok) {
        throw new Error('建立場次失敗')
      }

      await response.json()
      navigate('/control')
    } catch (err) {
      console.error(err)
      setError(err.message || '無法建立場次，請稍後再試')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="page">
      <div className="home-intro">
        <div>
          <h1>劇場字幕機</h1>
          <p>
            建立控制端場次後，控制者可上傳劇本、拆解字幕、逐句播放；
            觀眾或表演者可透過檢視端網址即時看到字幕。控制端使用
            OpenAI 分析劇本，按上下鍵或點擊字幕即可跳行。
          </p>
        </div>

        <div className="home-actions">
          <button onClick={createSession} disabled={creating}>
            {creating ? '建立中…' : '建立新的控制端場次'}
          </button>
          <button className="subtle-button" type="button" onClick={() => navigate('/control')}>
            直接前往控制端
          </button>
        </div>

        {error && <div className="status-error">{error}</div>}

        <div className="control-instructions">
          <strong>使用流程：</strong>
          <br />
          1. 建立場次後取得固定的檢視端網址
          <br />
          2. 控制端輸入 OpenAI API Key 並上傳劇本
          <br />
          3. OpenAI 會把劇本文字拆成字幕清單，右側可直接編輯
          <br />
          4. 按上下方向鍵或點擊字幕，即可切換檢視端字幕
        </div>
      </div>
    </div>
  )
}

export default HomePage
