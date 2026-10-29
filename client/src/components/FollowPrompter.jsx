import {useLayoutEffect, useRef} from 'react'
import {resolveLineText, roleToColor} from '../lib/displayPayload'

export default function FollowPrompter({enabled, line, currentIndex, cueWindow, languageId,
  roleColorEnabled, live = false, liveEntries = [], fontPercent = 100}) {
  const rootRef = useRef(null), currentRef = useRef(null), textRef = useRef(null)
  const format = item => {
    if (!item) return ''
    const text = resolveLineText(item, languageId)
    return item.type !== 'direction' && item.role && text ? `${item.role}：${text}` : text
  }
  const context = cueWindow?.currentIndex === currentIndex ? cueWindow : null
  const offset = context ? currentIndex - context.startIndex : 0
  const current = live ? liveEntries.at(-1) : context?.lines[offset] || line
  const previous = (live ? liveEntries.slice(-3, -1).map(entry => entry.displayText)
    : (context?.lines.slice(0, offset) || []).map(format)).filter(Boolean)
  const future = live ? [] : (context?.lines.slice(offset + 1) || []).map(format).filter(Boolean)
  const previousText = previous.join('\n')
  const futureText = future.join('\n')
  const currentText = live ? current?.displayText || ''
    : format(current) || (current?.type === 'direction' ? '（舞台指示）' : '等待字幕…')
  const color = !live && roleColorEnabled && current?.type !== 'direction' ? roleToColor(current?.role) : ''

  useLayoutEffect(() => {
    if (!enabled) return
    const root = rootRef.current, box = currentRef.current, text = textRef.current
    if (!root || !box || !text) return
    let frame = 0, disposed = false
    const fit = () => {
      if (disposed) return
      text.style.fontSize = ''
      root.dataset.context = 'all'
      const height = root.clientHeight
      if (!height) return
      const desired = Number.parseFloat(getComputedStyle(text).fontSize)
      const natural = box.getBoundingClientRect().height
      // Spend the available space on the current cue before showing context.
      root.dataset.context = natural > height * 0.75 ? 'none' : natural > height * 0.55 ? 'future' : 'all'
      if (natural <= height && text.scrollWidth <= text.clientWidth + 1) return
      root.dataset.context = 'none'
      let low = 8, high = desired
      for (let attempt = 0; attempt < 12; attempt++) {
        const size = (low + high) / 2
        text.style.fontSize = `${size}px`
        if (box.getBoundingClientRect().height <= height && text.scrollWidth <= text.clientWidth + 1) low = size
        else high = size
      }
      text.style.fontSize = `${low}px`
    }
    fit()
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(fit)
    })
    observer.observe(root)
    void document.fonts?.ready.then(fit)
    return () => { disposed = true; observer.disconnect(); cancelAnimationFrame(frame) }
  }, [enabled, currentText, previousText, futureText, fontPercent, languageId])

  return <main ref={rootRef} className="follow-prompter" aria-label="固定跟隨提詞" style={{'--prompter-font-scale': fontPercent / 100}}>
    {enabled && <>
      {previous.length > 0 && <div className="follow-prompter-context follow-prompter-previous" aria-label="前文台詞">
        {previous.map((text, index) => <div key={index}>{text}</div>)}
      </div>}
      <section ref={currentRef} className="follow-prompter-current" aria-label="目前台詞">
        <div ref={textRef} className="follow-prompter-text" style={color ? {color} : undefined}>{currentText}</div>
      </section>
      {future.length > 0 && <div className="follow-prompter-context follow-prompter-future" aria-label="後續台詞">
        {future.map((text, index) => <div key={index}>{text}</div>)}
      </div>}
    </>}
  </main>
}
