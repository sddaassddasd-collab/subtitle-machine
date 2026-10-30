// A position patch must match the loaded scene and script. In particular it
// must never replace local editor lines or undo an outstanding manual cue.
export function resolveControlPosition(payload, {sessionId, cellId, lines, pending, now, timeoutMs}) {
  if (payload?.sessionId !== sessionId || payload.cellId !== cellId || !Number.isInteger(payload.currentIndex) ||
    !payload.lineId || lines[payload.currentIndex]?.id !== payload.lineId) return null
  const retainPending = pending && Number.isInteger(pending.index) && lines[pending.index] &&
    pending.index !== payload.currentIndex && now - pending.requestedAt <= timeoutMs
  const index = retainPending ? pending.index : payload.currentIndex
  return {index, lineId: lines[index].id, pending: retainPending ? pending : null}
}
