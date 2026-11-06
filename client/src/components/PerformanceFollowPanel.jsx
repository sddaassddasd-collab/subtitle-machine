import {useEffect, useRef, useState} from 'react'
import './PerformanceFollowPanel.css'

const reasons = {ready: '等待台詞', context_changed: '等待定位', sustained_unmatched_speech: '持續偏離劇本，顯示即時字幕',
  script_reacquired: '已重新找到劇本', overlap_started: '交疊段輔助走格', paced_estimate: '依節奏估計，尚未辨識確認',
  overlap_limit: '交疊段已達上限，等待台詞', capture_gap: '收音中斷，已停止估計', overlap_exit_recognized: '已辨識出口台詞',
  operator_cancel: '已取消交疊走格', operator_pause: '交疊走格已暫停', operator_resume: '交疊走格繼續',
  overlap_quiet: '收音持續安靜，交疊走格已暫停', capture_stopped: '收音已暫停', provider_reconnecting: '重新收音，等待劇本定位',
  operator_script_lock: '已鎖定劇本輸出', operator_live_lock: '已鎖定即時字幕', automatic_assistance: '自動輔助已恢復'}

export default function PerformanceFollowPanel({session, lines, socketRef, runtime, active, currentIndex, onManual}) {
  const [draft, setDraft] = useState(null)
  const [range, setRange] = useState({name: '', start: '', end: '', minimumSeconds: 1.8, maximumSeconds: 45, charactersPerSecond: 4})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const revision = useRef(0), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const settings = draft || session.performanceFollowing || {automaticLive: false, overlapGroups: []}
  const groups = settings.overlapGroups.filter(g => g.cellId === session.selectedCellId)
  const edit = value => { revision.current++; setDraft(value) }
  const emit = (event, data, saved) => {
    if (!socketRef.current?.connected) { setMessage('尚未連線'); return }
    const sentRevision = revision.current
    setBusy(true)
    socketRef.current.timeout(6000).emit(event, {sessionId: session.id, ...data}, (error, response) => {
      if (!mounted.current) return
      setBusy(false)
      if (error || !response?.ok) { setMessage(response?.reason || '未確認成功，請重試'); return }
      if (saved && revision.current === sentRevision) setDraft(null)
      setMessage(saved ? '已儲存演出輔助設定' : '操作已生效')
    })
  }
  const command = action => emit('performance:action', {action})
  const add = () => {
    const start = Number(range.start) - 1, end = Number(range.end) - 1
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end - start >= 12 || !lines[end + 1]) {
      setMessage('請輸入 2～12 格的範圍，並保留下一格作為出口台詞'); return
    }
    if (lines.slice(start, end + 2).some(l => l.type === 'direction' || l.music)) {
      setMessage('交疊段及出口不能包含音樂或舞台指示'); return
    }
    const overlap = groups.some(g => {
      const a = lines.findIndex(l => l.id === g.startLineId), b = lines.findIndex(l => l.id === g.endLineId)
      return a >= 0 && start <= b && a <= end
    })
    if (overlap) { setMessage('範圍與既有交疊段重疊'); return }
    edit({...settings, overlapGroups: [...settings.overlapGroups, {id: crypto.randomUUID(), cellId: session.selectedCellId,
      startLineId: lines[start].id, endLineId: lines[end].id, name: range.name || '交疊段',
      minimumSeconds: Number(range.minimumSeconds), maximumSeconds: Number(range.maximumSeconds), charactersPerSecond: Number(range.charactersPerSecond)}]})
    setMessage('交疊段已加入，請儲存設定')
  }
  return <section className="performance-follow-panel" aria-label="演出輔助">
    <div className="performance-follow-status" aria-live="polite">
      <strong>演出輔助</strong>
      <span>{runtime?.source === 'live' ? '即時字幕 · 背景持續定位' : '劇本字幕'} · {reasons[runtime?.reason] || '持續比對台詞'}</span>
      {Number.isInteger(runtime?.backgroundIndex) && runtime?.source === 'live' && <span>背景候選：第 {runtime.backgroundIndex + 1} 格</span>}
      {Number.isInteger(runtime?.preparedIndex) && <span>語意候選：第 {runtime.preparedIndex + 1} 格（尚未換格）</span>}
      {runtime?.group && <span>第 {runtime.group.start + 1}～{runtime.group.end + 1} 格 · {runtime.group.speed.toFixed(2)} 倍 · {runtime.group.paused ? '暫停' : '估計中'}</span>}
    </div>
    <div className="transcription-actions">
      <button type="button" className="subtle-button" disabled={busy || (!active && !session.automaticLive)} onClick={() => command('lock-script')}>鎖定劇本輸出</button>
      <button type="button" className="subtle-button" disabled={busy || !active} onClick={() => command('lock-live')}>鎖定即時字幕</button>
      <button type="button" disabled={busy || !active} onClick={() => command('auto')}>恢復自動輔助</button>
      {session.subtitleControlMode === 'auto' && <button type="button" className="subtle-button" disabled={busy} onClick={onManual}>手動接管</button>}
      {!runtime?.group && <button type="button" className="subtle-button" disabled={busy || !active || !runtime?.groups?.some(g => g.valid && g.start === currentIndex)}
        onClick={() => command('start-overlap')}>啟動本段交疊走格</button>}
      {runtime?.group && <>
        <button type="button" disabled={busy || !active} onClick={() => command(runtime.group.paused ? 'resume' : 'pause')}>{runtime.group.paused ? '繼續走格' : '暫停走格'}</button>
        <button type="button" disabled={busy || !active} onClick={() => command('slower')}>慢一點</button>
        <button type="button" disabled={busy || !active} onClick={() => command('faster')}>快一點</button>
        <button type="button" className="subtle-button" disabled={busy || !active} onClick={() => command('cancel-overlap')}>取消本段估計</button>
      </>}
    </div>
    <details>
      <summary>即興切換與交疊段設定{draft ? '（尚未儲存）' : ''}</summary>
      <label className="checkbox-row"><input type="checkbox" checked={settings.automaticLive}
        onChange={e => edit({...settings, automaticLive: e.target.checked})}/>持續偏離劇本時自動顯示即時字幕，找到可靠台詞後接回（實驗功能）</label>
      <p className="input-note">先確認過劇本位置，持續收到可用發話且附近台詞對不上時才會切換。短暫改詞交由文字／語意比對；沒有辨識文字時不自動判定為即興。鎖定輸出只固定字幕來源，仍持續定位；人工跳格會取消估計並鎖定劇本來源。</p>
      <ul>{groups.map(g => {
        const a = lines.findIndex(l => l.id === g.startLineId), b = lines.findIndex(l => l.id === g.endLineId)
        const invalid = a < 0 || b <= a || b - a >= 12 || !lines[b + 1] || lines.slice(a, b + 2).some(l => l.type === 'direction' || l.music)
        return <li key={g.id}>{g.name}：{invalid ? '劇本已改動，範圍失效，請重設' : `第 ${a + 1}～${b + 1} 格，出口第 ${b + 2} 格`} · 最少 {g.minimumSeconds} 秒／格，最長 {g.maximumSeconds} 秒
          <button type="button" className="subtle-button" onClick={() => edit({...settings, overlapGroups: settings.overlapGroups.filter(x => x.id !== g.id)})}>移除</button></li>
      })}</ul>
      <div className="performance-range-inputs">
        <label>段落名稱<input value={range.name} onChange={e => setRange({...range, name: e.target.value})}/></label>
        <label>第一格（進入台詞）<input type="number" min="1" max={lines.length} value={range.start} onChange={e => setRange({...range, start: e.target.value})}/></label>
        <label>最後一格<input type="number" min="2" max={lines.length - 1} value={range.end} onChange={e => setRange({...range, end: e.target.value})}/></label>
        <label>最低閱讀秒數<input type="number" min="1" max="8" step="0.1" value={range.minimumSeconds} onChange={e => setRange({...range, minimumSeconds: e.target.value})}/></label>
        <label>本段最長秒數<input type="number" min="5" max="120" value={range.maximumSeconds} onChange={e => setRange({...range, maximumSeconds: e.target.value})}/></label>
        <label>起始速度（字／秒）<input type="number" min="2" max="12" step="0.5" value={range.charactersPerSecond} onChange={e => setRange({...range, charactersPerSecond: e.target.value})}/></label>
      </div>
      <p className="input-note">確認進入第一格後才自動開始；使用近期語速及可用的參考片段時長調整節奏。到達最後一格、時間上限或收音中斷後停止估計，等待出口台詞。估計不代表該句已被辨識。</p>
      <div className="transcription-actions"><button type="button" className="subtle-button" disabled={busy} onClick={add}>加入交疊段</button>
        <button type="button" disabled={busy || !draft} onClick={() => emit('performance:set-settings', {settings}, true)}>儲存演出輔助設定</button></div>
    </details>
    {message && <p role="status">{message}</p>}
  </section>
}
