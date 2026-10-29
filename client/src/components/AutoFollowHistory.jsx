import {useEffect, useState} from 'react'

const sources = {audio: '參考錄音', transcript: '文字辨識', onset: '起音預推', correction: '跳詞校正',
  silence: '靜默切換', manual: '人工操作', initial: '起始位置', context: '場次／版本切換', resume: '恢復位置', system: '系統定位'}
const statuses = {confirmed: '已確認', pending: '已進入、未確認', manual: '人工進入、未確認',
  initial: '起始／恢復位置', direction: '舞台指示', unentered: '未進入，待查',
  skipped_auto: '自動跨過，未進入', skipped_manual: '人工跨過，未進入'}
const eventNames = {run_start: '開始紀錄', run_end: '結束紀錄', interruption: '紀錄中斷', logging_gap: '紀錄不完整',
  cue_enter: '進入字幕格', cue_confirm: '字幕確認', display_ack: '顯示回報', diagnostic: '定位診斷',
  capture_status: '收音狀態', capture_audio: '收到現場音訊', control_mode: '跟戲模式切換'}
const captureNames = {ready: '辨識連線就緒', connecting: '辨識連線中', paused: '已暫停', error: '發生錯誤'}
const time = at => at == null ? '—' : new Date(at).toLocaleString('zh-TW', {hour12: false})
const labels = confirmations => [...new Set(confirmations.map(item => sources[item.source] || item.source))].join('、') || '尚無確認'
async function request(url, options = {}) {
  const response = await fetch(url, {cache: 'no-store', ...options})
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `讀取失敗（${response.status}）`)
  }
  return response
}

export default function AutoFollowHistory({open, sessionId, historyStatus}) {
  const [runs, setRuns] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [data, setData] = useState(null)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [filter, setFilter] = useState('all')
  const [contextId, setContextId] = useState('all')
  const [page, setPage] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const root = `/api/session/${encodeURIComponent(sessionId)}/follow-history`

  useEffect(() => {
    if (!open || !sessionId) return
    const controller = new AbortController()
    let timer
    async function load() {
      try {
        const list = await (await request(`${root}?offset=${offset}`, {signal: controller.signal})).json()
        if (controller.signal.aborted) return
        setRuns(list.runs); setHasMore(list.hasMore)
        const id = list.runs.some(run => run.id === selectedId) ? selectedId : list.runs[0]?.id || ''
        if (id !== selectedId) setSelectedId(id)
        const report = id ? await (await request(`${root}/${id}`, {signal: controller.signal})).json() : null
        if (controller.signal.aborted) return
        setData(report); setError(''); setLoaded(true)
      } catch (error) {
        if (!controller.signal.aborted) setError(error.message)
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 5000)
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [open, sessionId, root, offset, selectedId, refresh])

  const report = data?.run.id === selectedId ? data : null
  const current = report?.run.endedAt === null
  const rows = (report?.rows || []).filter(row => contextId === 'all' || row.contextId === contextId).filter(row => filter === 'unentered' ? row.type !== 'direction' && !row.entryCount
    : filter === 'pending' ? row.type !== 'direction' && row.visits.some(visit => !visit.confirmations.length)
      : filter === 'manual' ? row.visits.some(visit => visit.source === 'manual') : true)
  const pages = Math.max(1, Math.ceil(rows.length / 40)), safePage = Math.min(page, pages - 1)

  async function act(action, work) {
    setBusy(action); setError('')
    try { await work(); setRefresh(value => value + 1) }
    catch (error) { setError(error.message) }
    finally { setBusy('') }
  }
  return <section className="follow-history" aria-label="自動跟戲歷程">
    <h4>跟戲歷程與匯出</h4>
    <p>自動跟戲開始時由後端記錄，收合此視窗不影響。停止收音會標記暫停；結束紀錄後再開始，會建立新的一次。</p>
    {(error || historyStatus?.error || report?.status.error) && <p className="control-status-error" role="alert">
      {error || historyStatus?.error || report?.status.error}</p>}
    <div className="follow-history-actions">
      <button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={() => {
        if ((report?.status.runId || historyStatus?.runId) && !window.confirm('結束目前紀錄並開始新一次？舊紀錄會保留。')) return
        void act('開始中', async () => {
          const result = await (await request(`${root}/start`, {method: 'POST'})).json()
          setOffset(0); setSelectedId(result.id); setPage(0); setContextId('all')
        })
      }}>開始新一次紀錄</button>
      <button type="button" className="subtle-button" disabled={Boolean(busy) || !current} onClick={() => {
        void act('結束中', () => request(`${root}/${selectedId}/end`, {method: 'POST'}))
      }}>結束本次紀錄</button>
      <button type="button" className="subtle-button" disabled={Boolean(busy)} onClick={() => setRefresh(value => value + 1)}>重新整理</button>
      {busy && <span role="status">{busy}…</span>}
    </div>
    <label className="follow-history-select">排練紀錄
      <select value={selectedId} onChange={event => { setSelectedId(event.target.value); setPage(0); setContextId('all') }}>
        {!runs.length && <option value="">尚無紀錄</option>}
        {runs.map(run => <option key={run.id} value={run.id}>{time(run.startedAt)} · {run.name} · {run.endedAt === null ? '進行中' : '已結束'}</option>)}
      </select>
    </label>
    {(offset > 0 || hasMore) && <div className="follow-history-actions">
      <button type="button" disabled={!offset} onClick={() => { setOffset(value => Math.max(0, value - 20)); setSelectedId(''); setPage(0) }}>較新紀錄</button>
      <span>紀錄第 {Math.floor(offset / 20) + 1} 頁</span>
      <button type="button" disabled={!hasMore} onClick={() => { setOffset(value => value + 20); setSelectedId(''); setPage(0) }}>較舊紀錄</button>
    </div>}
    {report && <>
      <p role="status">{current ? '紀錄進行中' : `已結束：${time(report.run.endedAt)}`} · 台詞版本 {report.totals.cueVersions} 格 ·
        已進入 {report.totals.entered} 格 · 未進入 {report.totals.unentered} 格 · 共經過 {report.totals.visits} 次
        {report.hasGaps && ' · 含收音／服務中斷，請核對時間線'}</p>
      <div className="follow-history-actions">
        <a className="primary-button follow-history-export" href={`${root}/${selectedId}?format=csv`} download>匯出 CSV</a>
        <a className="subtle-button follow-history-export" href={`${root}/${selectedId}?format=json`} download>匯出完整 JSON</a>
        <button type="button" className="subtle-button danger-button" disabled={Boolean(busy) || current} onClick={() => {
          if (!window.confirm('確定刪除這次跟戲歷程？其他排練紀錄與劇本會保留。')) return
          void act('刪除中', async () => { await request(`${root}/${selectedId}`, {method: 'DELETE'}); setSelectedId(''); setData(null) })
        }}>刪除這次紀錄</button>
      </div>
      <p className="follow-history-note">未進入不等於辨識失敗，可能尚未演到、人工跳過或收音中斷。起始位置不計自動觸發；「已確認」也不保證配對正確。顯示回報不代表觀眾實際看見。</p>
      <label>篩選 <select value={filter} onChange={event => { setFilter(event.target.value); setPage(0) }}>
        <option value="all">全部字幕格</option><option value="unentered">未進入／被跨過</option>
        <option value="pending">曾進入但未確認</option><option value="manual">有人工介入</option>
      </select></label>
      {report.contexts.length > 1 && <label className="follow-history-select">場次／版本
        <select value={contextId} onChange={event => { setContextId(event.target.value); setPage(0) }}>
          <option value="all">全部場次／版本</option>
          {report.contexts.map((context, index) => <option key={context.contextId} value={context.contextId}>
            {context.cellName || '場次'} · 版本 {index + 1} · {time(context.at)}
          </option>)}
        </select>
      </label>}
      <div className="follow-history-table-wrap"><table className="follow-history-table">
        <thead><tr><th>字幕格／版本</th><th>台詞</th><th>錄音片段</th><th>最近進入方式</th><th>後續確認</th><th>狀態／歷程</th></tr></thead>
        <tbody>{rows.slice(safePage * 40, (safePage + 1) * 40).map(row => {
          const last = row.visits.at(-1)
          return <tr key={`${row.contextId}:${row.index}`}>
            <td>{row.index + 1}<small>{row.cellName || '場次'}<br/>版本 {report.contexts.findIndex(context => context.contextId === row.contextId) + 1}</small></td>
            <td>{row.text}</td>
            <td>{row.reference.usable ? '可用' : '無可用片段'}</td>
            <td>{sources[last?.source] || '無進入紀錄'}</td>
            <td>{last ? labels(last.confirmations) : '—'}</td>
            <td>{statuses[row.status]}{row.visits.length > 0 && <details><summary>共 {row.entryCount} 次</summary>
              {row.visits.map((visit, index) => <div className="follow-history-visit" key={visit.id}>
                <strong>第 {index + 1} 次 · {sources[visit.source]} · {statuses[visit.status]}</strong>
                <div>{time(visit.enteredAt)}{visit.audioMs != null && ` · 收音 ${(visit.audioMs / 1000).toFixed(2)} 秒`}</div>
                {visit.confirmations.map(item => <div key={item.id}>{sources[item.source]}{item.completed ? '（句尾確認）' : ''}
                  {Number.isFinite(item.referenceSeconds) && ` · 參考 ${item.referenceSeconds.toFixed(2)} 秒`}
                  {item.text && `：${item.text}`}</div>)}
                {visit.displayAcks.map(item => <div key={item.id}>顯示回報 {item.role}：{item.ms} ms</div>)}
              </div>)}
            </details>}{row.skips.length > 0 && <small>跨過紀錄：{row.skips.map(skip => `${sources[skip.source]} ${skip.fromIndex + 1}→${skip.toIndex + 1}`).join('、')}</small>}</td>
          </tr>
        })}</tbody>
      </table></div>
      <div className="follow-history-actions">
        <button type="button" disabled={!safePage} onClick={() => setPage(safePage - 1)}>上一頁</button>
        <span>{safePage + 1}／{pages} 頁 · {rows.length} 格</span>
        <button type="button" disabled={safePage + 1 >= pages} onClick={() => setPage(safePage + 1)}>下一頁</button>
      </div>
      <details><summary>最近事件與診斷（完整事件請匯出 JSON）</summary>
        <ol className="follow-history-events">{report.recentEvents.map(event => <li key={event.id}>
          <time>{time(event.at)}</time> · {eventNames[event.type] || event.type}
          {Number.isInteger(event.index) && ` · 第 ${event.index + 1} 格`}
          {event.source && ` · ${sources[event.source] || event.source}`}
          {event.status && ` · ${captureNames[event.status] || event.status}`}
          {event.mode && ` · ${event.mode === 'auto' ? '自動跟戲' : '手動跟戲'}`}
          {event.message && ` · ${event.message}`}{event.text && ` · ${event.text}`}
        </li>)}</ol>
      </details>
    </>}
    {!loaded && !error && <p role="status">正在讀取跟戲歷程…</p>}
    {loaded && !runs.length && !error && <p>尚無歷程。開始自動跟戲會自動建立，也可按「開始新一次紀錄」。此功能啟用前的歷程無法補回。</p>}
  </section>
}
