export const publicViewMode = search => new URLSearchParams(search).get('mode') === 'prompter' ? 'prompter' : 'viewer'

// A mode switch can legitimately return the same server revision with a
// different payload. Old HTTP responses and old-mode socket events cannot win.
export class PublicDisplayGate {
  constructor(mode = 'viewer') { this.mode = mode; this.generation = 0; this.reset() }
  reset() { this.generation++; this.sessionId = ''; this.revision = 0; this.appliedGeneration = -1 }
  select(mode) { if (mode !== this.mode) { this.mode = mode; this.generation++ } }
  accepts(payload, mode = this.mode, generation = this.generation) {
    if (mode !== this.mode || generation !== this.generation) return false
    const sessionId = payload?.sessionId || ''
    const revision = Number.isSafeInteger(payload?.viewerRevision) ? payload.viewerRevision : 0
    if (sessionId === this.sessionId && revision > 0 &&
      (revision < this.revision || (revision === this.revision && this.appliedGeneration === generation))) return false
    this.revision = sessionId === this.sessionId ? Math.max(revision, this.revision) : revision
    this.sessionId = sessionId; this.appliedGeneration = generation
    return true
  }
}

export function preventPrompterScroll(event) {
  if (event.type === 'wheel') {
    if (!event.ctrlKey) event.preventDefault() // Preserve browser zoom.
    return
  }
  if (event.type === 'touchmove') {
    if (event.touches?.length === 1) event.preventDefault()
    return
  }
  if (event.target?.closest?.('button, a, input, select, textarea, [role="combobox"]')) return
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.preventDefault()
}
