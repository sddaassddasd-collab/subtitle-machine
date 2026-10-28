import {useRef} from 'react'

export default function RecordingPlaybackControls({playerRef, playback, timeLabel}) {
  const scrub = useRef(null)
  const finishScrub = () => {
    const resume = scrub.current
    scrub.current = null
    if (resume) void playerRef.current?.play(undefined, playback.duration)
  }
  return <div className="recording-player" role="group" aria-label="錄音播放器">
    <div className="recording-actions">
      <button type="button" className="subtle-button" disabled={!playback.available}
        onClick={() => playback.playing ? playerRef.current?.pause() : void playerRef.current?.play()}>
        {playback.playing ? '暫停錄音' : '播放錄音'}
      </button>
      <span aria-label="原音播放位置">{timeLabel(playback.currentTime)} / {timeLabel(playback.duration)}</span>
      <span role="status">{playback.loading ? '讀取錄音…' : playback.preparing ? '準備音訊…' : playback.playing ? '播放中' : ''}</span>
    </div>
    <input type="range" aria-label="錄音播放位置" min="0" max={playback.duration || 1} step="0.01"
      disabled={!playback.available} value={playback.currentTime} aria-valuetext={timeLabel(playback.currentTime)}
      onPointerDown={event => {
        scrub.current = playback.playing; playerRef.current?.pause()
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onChange={event => { void playerRef.current?.seek(Number(event.target.value), {autoplay: scrub.current === null && playback.playing}) }}
      onPointerUp={finishScrub} onPointerCancel={finishScrub}/>
    <label className="recording-volume">音量<input type="range" aria-label="錄音音量" min="0" max="1" step="0.05"
      value={playback.volume} onChange={event => playerRef.current?.setVolume(event.target.value)}/></label>
    {playback.error && <p className="recording-error" role="alert">{playback.error}</p>}
  </div>
}
