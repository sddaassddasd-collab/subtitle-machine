import { useCallback, useEffect, useRef, useState } from 'react'

// Report after React commits and the browser has had a paint opportunity.
// The server measures the round trip, so no client/server clock sync is needed.
export function useAutoFollowDisplayAck(socketRef, displayIdentity = '') {
  const [decisionId, setDecisionId] = useState(null)
  const lastSentRef = useRef(null)
  const observeDisplay = useCallback((payload) => {
    setDecisionId(payload?.source === 'script' && payload?.displayEnabled !== false
      ? payload?.autoFollowDecision?.id || null : null)
  }, [])

  useEffect(() => {
    const key = `${displayIdentity}:${decisionId}`
    if (!decisionId || lastSentRef.current === key) return
    let frame = 0
    const schedule = () => {
      cancelAnimationFrame(frame)
      if (document.visibilityState !== 'visible') return
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const socket = socketRef.current
          if (document.visibilityState !== 'visible' || !socket?.connected ||
            lastSentRef.current === key) return
          lastSentRef.current = key
          socket.emit('auto-follow:displayed', { decisionId })
        })
      })
    }
    schedule()
    document.addEventListener('visibilitychange', schedule)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', schedule)
    }
  }, [decisionId, socketRef, displayIdentity])

  return observeDisplay
}
