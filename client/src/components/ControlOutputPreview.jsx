import CaptionSurface from './CaptionSurface'
import {latestCaptionRows} from '../lib/caption-frame'
import {normalizeDisplayPayload, resolveLanguageDisplayList, resolveLineText, roleToColor} from '../lib/displayPayload'

export default function ControlOutputPreview({payload, scope}) {
  const out = normalizeDisplayPayload(payload)
  const languages = resolveLanguageDisplayList(out.languages, out.defaultLanguageId, out.languageMode, out.secondaryLanguageId)
  const entries = out.liveEntries.length ? out.liveEntries : out.liveLines.map(text => ({text}))
  const liveLanguages = languages.map(l => ({id: l.id, code: out.captionPresentation.languageCodes[l.id],
    source: out.captionPresentation.languageCodes[l.id] === 'source' || !out.captionPresentation.performance}))
  const rows = out.captionPresentation.performance ? latestCaptionRows(entries, liveLanguages)
    : entries.map((entry, index) => ({id: entry.id || String(index), text: entry.text}))
  return <CaptionSurface scope={`${scope}:${out.defaultLanguageId}:${out.secondaryLanguageId || ''}:${out.languageMode}`}
    enabled={out.enabled} source={out.line?.type === 'direction' && out.source !== 'transcription' ? 'direction' : out.source}
    scriptRows={languages.map(l => ({id: l.id, text: resolveLineText(out.line, l.id)}))} liveRows={rows}
    entryId={out.source === 'transcription' ? entries.at(-1)?.id || '' : out.line?.id || ''}
    color={out.roleColorEnabled && out.source !== 'transcription' ? roleToColor(out.line?.role) : ''}
    animation={out.captionPresentation.performance && out.captionPresentation.animation} className="viewer-preview-text" strong/>
}
