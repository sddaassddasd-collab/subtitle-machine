import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import {resolveLineText, roleToColor} from '../lib/displayPayload'

const PAGE_SIZE = 24
const EDGE_DISTANCE = 140
const DRAG_DISTANCE = 5
const NAVIGATION_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

export default function FollowPrompter(props) {
  const {enabled, live, cueWindow, viewerToken, fontPercent = 100} = props
  return <main className="follow-prompter" aria-label="多行字幕" style={{'--prompter-font-scale': fontPercent / 100}}>
    {enabled && <Timeline key={`${viewerToken}:${live ? 'live' : cueWindow?.cellId || 'script'}`} {...props} />}
  </main>
}

function Timeline({line, currentIndex, cueWindow, viewerToken, languageId, roleColorEnabled, live, liveEntries, fontPercent, onFollowPosition}) {
  const viewport = useRef(null)
  const track = useRef(null)
  const previousLayout = useRef(null)
  const frame = useRef(0)
  const pointer = useRef(null)
  const request = useRef(null)
  const [browse, setBrowse] = useState(null)
  const [loadError, setLoadError] = useState('')
  const play = useMemo(() => live ? {startIndex: 0, total: liveEntries.length, lines: liveEntries}
    : cueWindow?.currentIndex === currentIndex ? cueWindow : {startIndex: currentIndex, total: currentIndex + 1, lines: [line]},
  [live, liveEntries, cueWindow, currentIndex, line])
  const view = browse || play
  const activeIndex = live ? play.lines.length - 1 : currentIndex
  const activeItem = play.lines[activeIndex - play.startIndex]
  const active = activeItem?.id || `index-${activeIndex}`
  const displayRows = useMemo(() => view.lines.map((item, offset) => {
    const index = view.startIndex + offset
    const text = live ? item?.displayText : resolveLineText(item, languageId)
    const prefix = !live && item?.type !== 'direction' && item?.role && text ? `${item.role}：` : ''
    return {index, key: item?.id || `index-${index}`, item, text: text ? prefix + text : ''}
  }).filter(row => row.text || (!live && row.index === (view.currentIndex ?? view.startIndex)) || (live && row.index === view.lines.length - 1)),
  [view, live, languageId])

  useEffect(() => () => {
    request.current?.abort()
    cancelAnimationFrame(frame.current)
  }, [])

  useLayoutEffect(() => {
    const scroller = viewport.current
    const content = track.current
    let initial = true
    let fitted = null
    const align = () => {
      cancelAnimationFrame(frame.current)
      if (fitted) fitted.style.fontSize = ''
      fitted = browse ? null : [...content.children].find(row => row.dataset.cue === active)
      if (fitted && scroller.clientHeight > 0 && fitted.offsetHeight > scroller.clientHeight) {
        let low = 8
        let high = Number.parseFloat(getComputedStyle(fitted).fontSize)
        for (let i = 0; i < 10; i++) {
          const size = (low + high) / 2
          fitted.style.fontSize = `${size}px`
          if (fitted.offsetHeight <= scroller.clientHeight) low = size
          else high = size
        }
        fitted.style.fontSize = `${low}px`
      }
      const old = previousLayout.current
      const scroll = scroller.scrollTop
      const positions = new Map([...content.children].map(row => [row.dataset.cue, {top: row.offsetTop, height: row.offsetHeight}]))
      const anchor = old && [old.active, ...old.positions.keys()].find(key => old.positions.has(key) && positions.has(key))
      if (anchor && (browse || old.active !== active)) {
        scroller.scrollTop = scroll + positions.get(anchor).top - old.positions.get(anchor).top
        if (pointer.current?.dragging) pointer.current.scroll += scroller.scrollTop - scroll
      }
      previousLayout.current = {positions, active, currentIndex, browsing: Boolean(browse)}
      if (browse || !positions.has(active)) return
      const row = positions.get(active)
      const goal = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight,
        row.top - Math.max(0, (scroller.clientHeight - row.height) / 2)))
      const start = scroller.scrollTop
      const changed = initial && old && old.active !== active && !old.browsing
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      const distant = changed && (!anchor || (!live && Math.abs(currentIndex - old.currentIndex) > 4))
      if (!changed || distant || Math.abs(goal - start) < 1 || reducedMotion) {
        scroller.scrollTop = goal
        if (distant && !reducedMotion) scroller.animate?.([{opacity: 0.65}, {opacity: 1}], {duration: 140})
        if (!live) onFollowPosition?.(currentIndex)
        return
      }
      const started = performance.now()
      const tick = now => {
        const progress = Math.min(1, (now - started) / 260)
        scroller.scrollTop = start + (goal - start) * (1 - (1 - progress) ** 3)
        if (progress < 1) frame.current = requestAnimationFrame(tick)
        else if (!live) onFollowPosition?.(currentIndex)
      }
      frame.current = requestAnimationFrame(tick)
    }
    align()
    initial = false
    const observer = new ResizeObserver(entries => {
      // Ignore the observer's initial notification to let an active transition finish.
      if (entries.every(entry => entry.target === scroller &&
        entry.target.clientHeight === observedHeight && entry.target.clientWidth === observedWidth)) return
      observedHeight = scroller.clientHeight
      observedWidth = scroller.clientWidth
      align()
    })
    let observedHeight = scroller.clientHeight, observedWidth = scroller.clientWidth
    observer.observe(scroller)
    return () => {
      observer.disconnect()
      if (fitted) fitted.style.fontSize = ''
    }
  }, [active, browse, currentIndex, displayRows, fontPercent, live, onFollowPosition])

  async function loadEdge(direction, window = browse) {
    if (!window?.cellId || live || request.current) return
    const {startIndex, total, lines} = window
    const end = startIndex + lines.length
    if (direction === 'before' ? startIndex === 0 : end >= total) return
    const start = direction === 'before' ? Math.max(0, startIndex - PAGE_SIZE + 1) : end - 1
    const controller = new AbortController()
    request.current = controller
    setLoadError('')
    try {
      const query = new URLSearchParams({start: String(start), cellId: window.cellId})
      const response = await fetch(`/api/viewer/${encodeURIComponent(viewerToken)}/cues?${query}`, {signal: controller.signal})
      if (!response.ok) throw new Error('無法載入更多字幕')
      const page = await response.json()
      if (controller.signal.aborted) return
      const edge = direction === 'before' ? lines[0] : lines.at(-1)
      const overlap = direction === 'before' ? startIndex - page.startIndex : end - 1 - page.startIndex
      if (page.cellId !== window.cellId || page.total !== total || page.lines?.[overlap]?.id !== edge?.id) {
        throw new Error('字幕已更新，請回到直播')
      }
      setBrowse(current => current !== window ? current : direction === 'before'
        ? {...window, startIndex: page.startIndex, lines: [...page.lines.slice(0, overlap), ...lines]}
        : {...window, lines: [...lines, ...page.lines.slice(overlap + 1)]})
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(error.message)
    } finally {
      if (request.current === controller) request.current = null
    }
  }

  function browseIn(direction) {
    if (!browse) {
      cancelAnimationFrame(frame.current)
      onFollowPosition?.(null)
      setBrowse(play)
      void loadEdge(direction, play)
    } else if (loadError) void loadEdge(direction)
  }

  function followLive() {
    request.current?.abort()
    request.current = null
    setLoadError('')
    setBrowse(null)
    viewport.current.focus({preventScroll: true})
  }

  function onScroll(event) {
    if (!browse || loadError) return
    const el = event.currentTarget
    if (el.scrollTop < EDGE_DISTANCE && browse.startIndex > 0) void loadEdge('before')
    else if (el.scrollHeight - el.clientHeight - el.scrollTop < EDGE_DISTANCE) void loadEdge('after')
  }

  function drag(event) {
    const gesture = pointer.current
    if (!gesture || gesture.id !== event.pointerId) return
    const delta = event.clientY - gesture.y
    if (Math.abs(delta) < DRAG_DISTANCE && !gesture.dragging) return
    gesture.dragging = true
    browseIn(delta > 0 ? 'before' : 'after')
    event.currentTarget.scrollTop = gesture.scroll - delta
  }

  return <>
    <div ref={viewport} className="follow-prompter-viewport" data-browsing={Boolean(browse)}
      tabIndex={0} aria-label="字幕時間線" onScroll={onScroll}
      onWheel={event => {
        if (!event.deltaY || event.ctrlKey || event.metaKey) return
        const direction = event.deltaY < 0 ? 'before' : 'after'
        browseIn(direction)
      }}
      onKeyDown={event => {
        if (!NAVIGATION_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return
        browseIn(['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey) ? 'before' : 'after')
      }}
      onTouchStart={event => { pointer.current = event.touches.length === 1 ? {id: null, y: event.touches[0].clientY} : null }}
      onTouchMove={event => {
        const gesture = pointer.current
        if (gesture?.id !== null || event.touches.length !== 1) return
        const delta = event.touches[0].clientY - gesture.y
        if (Math.abs(delta) >= DRAG_DISTANCE) browseIn(delta > 0 ? 'before' : 'after')
      }}
      onTouchEnd={() => { pointer.current = null }}
      onTouchCancel={() => { pointer.current = null }}
      onPointerDown={event => {
        if (event.pointerType === 'touch' || event.button !== 0) return
        pointer.current = {id: event.pointerId, y: event.clientY, scroll: event.currentTarget.scrollTop}
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={drag}
      onLostPointerCapture={() => { pointer.current = null }}>
      <div className="follow-prompter-track" ref={track}>
        {displayRows.map(row => {
          const current = row.key === active
          const color = current && !live && roleColorEnabled && row.item?.type !== 'direction' ? roleToColor(row.item?.role) : ''
          return <div className="follow-prompter-cue" key={row.key} data-cue={row.key}
            aria-current={current ? 'true' : undefined} style={color ? {color} : undefined}>
            {row.text || (row.item?.type === 'direction' ? '（舞台指示）' : '等待字幕…')}
          </div>
        })}
      </div>
    </div>
    {browse && <div className="follow-prompter-live-control">
      {loadError && <span role="status">{loadError}</span>}
      <button type="button" className="follow-prompter-live-button" aria-label="回到直播位置" onClick={followLive}>
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
          <path d="M8.5 8.5a5 5 0 0 0 0 7m7-7a5 5 0 0 1 0 7M5.5 5.5a9 9 0 0 0 0 13m13-13a9 9 0 0 1 0 13" />
        </svg>
      </button>
    </div>}
  </>
}
