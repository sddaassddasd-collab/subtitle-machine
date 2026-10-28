import {useEffect, useRef, useState} from 'react'
import {RecordingPlayback} from './recording-playback.js'
import {openPlaybackDecoder} from './recording-playback-decoder.js'

const empty = {duration: 0, currentTime: 0, playing: false, preparing: false, loading: false, available: false, volume: 1, error: ''}

export function useRecordingPlayback({file, url, visible}) {
  const playerRef = useRef(null)
  const [playback, setPlayback] = useState(empty)
  useEffect(() => {
    if (!file && !url) { setPlayback(empty); return }
    const player = new RecordingPlayback({decoderFactory: openPlaybackDecoder, onUpdate: setPlayback})
    playerRef.current = player
    void player.open(file ? {file} : {url})
    return () => { player.dispose(); if (playerRef.current === player) playerRef.current = null }
  }, [file, url])
  useEffect(() => { if (!visible) playerRef.current?.pause() }, [visible])
  return {playerRef, playback}
}
