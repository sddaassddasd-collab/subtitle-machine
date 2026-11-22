const SILENCE_TIMEOUT_REASON = 'silence_timeout';

function normalizeSilenceTimeout(settings) {
  const minutes = settings?.minutes;
  return {enabled: settings?.enabled === true,
    minutes: Number.isInteger(minutes) ? Math.min(120, Math.max(1, minutes)) : 5};
}

// Count actual quiet audio. Time spent waiting for packets contributes nothing.
function reachedSilenceTimeout(stream, settings, {quiet, durationMs, at, gap, sequence}) {
  if (!settings?.enabled) return false;
  const previous = stream.silenceWindow;
  const skipped = Number.isInteger(sequence) && Number.isInteger(previous?.sequence) && sequence !== previous.sequence + 1;
  const continuous = !gap && !skipped && previous && at - previous.at <= 1000;
  const elapsedMs = quiet ? (continuous ? previous.elapsedMs : 0) + durationMs : 0;
  stream.silenceWindow = {at, elapsedMs, sequence};
  return elapsedMs >= settings.minutes * 60000;
}

module.exports = {SILENCE_TIMEOUT_REASON, normalizeSilenceTimeout, reachedSilenceTimeout};
