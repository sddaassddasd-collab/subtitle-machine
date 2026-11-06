import {useLayoutEffect, useRef, useState} from 'react'
import {captionFrame} from '../lib/caption-frame'

export default function CaptionSurface({scope, enabled, source, scriptRows, liveRows, entryId, color, animation, className, strong = false}) {
  const [previous, setPrevious] = useState(null)
  const rootRef = useRef(null), keyRef = useRef('')
  const frame = captionFrame({scope, enabled, source, scriptRows, liveRows, entryId, color}, previous)
  const signature = JSON.stringify(frame)
  useLayoutEffect(() => {
    setPrevious(old => JSON.stringify(old) === signature ? old : JSON.parse(signature))
  }, [signature])
  useLayoutEffect(() => {
    const changed = keyRef.current && keyRef.current !== frame.key
    keyRef.current = frame.key
    if (!changed || !frame.key || !animation || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const effect = rootRef.current?.animate?.([{opacity: .85}, {opacity: 1}], {duration: 120, easing: 'ease-out'})
    return () => effect?.cancel()
  }, [frame.key, animation])
  return <div ref={rootRef} className={`${className} caption-surface${frame.rows.length > 1 ? ' caption-surface-stack' : ''}`}
    style={frame.color ? {color: frame.color} : undefined} aria-live="polite" aria-atomic="true">
    {frame.rows.map(row => <div key={row.id} className="caption-language-line">
      {strong ? <strong>{row.text || '\u00a0'}</strong> : row.text || '\u00a0'}
    </div>)}
  </div>
}
