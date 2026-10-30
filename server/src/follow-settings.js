// Shared by the decision engines and diagnostic exports: saved settings must
// describe the rules actually used, rather than a second copy of the defaults.
const TEXT_SETTINGS = Object.freeze({
  maxHeard: 120, sequenceTtlMs: 10000, historyMs: 4000, historyItems: 2, retainedItems: 8,
  nearbyBehind: 3, nearbyAhead: 18, minimumConfidence: 0.78, contextualShortConfidence: 0.70,
  strongConfidence: 0.88, minimumMargin: 0.07, correctionIntervalMs: 400,
  relocationEvidence: 6, catchUpAhead: 4, catchUpConfidence: 0.92, catchUpEvidence: 8,
  shortMinLength: 3, shortMaxLength: 8, shortMaxEdits: 1, shortMatchedCharacters: 3,
  predictedShortMatchedCharacters: 2, localTrailingCharacters: 2, localTrailingPenalty: 0.015,
  localInsertionCost: 0.35, localFillers: '我他它呢啊呀喔哦啦',
  localMinimumMatches: 4, localMatchedCoverage: 0.6, recoveryAfterMs: 2500, recoveryTtlMs: 30000,
  recoveryAhead: 12, recoveryMinimumConfidence: 0.92, recoveryMinimumEvidence: 6,
  nearEndingProgress: 0.7, nearEndingRemaining: 3, spanCoverage: 0.8,
  recoveryConfidence: 0.9, recoveryPenalty: 0.04, recoveryLengths: Object.freeze([24, 16, 10, 6]),
  contextBonus: 0.04, contextConfidence: 0.85, expectationBonus: 0.025,
  openingMinEvidence: 2, sequenceOpeningMinEvidence: 3, nearOpeningMaxEvidence: 12,
  normalization: 'NFKC/opencc-cn-twp/remove-parentheses-punctuation',
});
const ONSET_SETTINGS = Object.freeze({
  maxPacketMs: 100, minimumThreshold: 0.025, maximumThreshold: 0.12, noiseMultiplier: 4,
  releaseRatio: 0.45, noiseSmoothing: 0.98, quietMs: 120, loudMs: 40,
  directionSilenceMs: 3000, maximumGapMs: 100,
});
const ACOUSTIC_SETTINGS = Object.freeze({
  minimumConfidence: 0.80, minimumMargin: 0.035, strongConfidence: 0.84,
  normalSupport: 2, provisionalSupport: 3, allowedStatuses: Object.freeze(['auto', 'manual', 'review']),
  ahead: 4, minLiveFrames: 12, maxLiveFrames: 60, comparisonEveryFrames: 4,
  liveLengths: Object.freeze([12, 24, 40, 60]), forwardLiveFrames: 24, jumpLiveFrames: 40,
  forwardSupport: 3, forwardSupportMs: 320, forwardProgressMs: 120,
  minimumProgressRatio: 0.25, maximumProgressRatio: 2.8,
  recoveryAfterMs: 3000, recoveryExpandMs: 8000, recoveryAhead: 12, recoveryMaxAhead: 24,
  hintTtlMs: 3000, hintMinimumConfidence: 0.8, hintMinimumEvidence: 6,
  quietRms: 0.001, referenceQuietRms: 0.0008,
  quietClearFrames: 3, backwardToleranceFrames: 2, dtwPenalty: 0.025,
  minSpanRatio: 0.35, maxSpanRatio: 2.8, searchBehindFrames: 75, searchMinFrames: 300, searchAheadFrames: 200,
  quietCompletionProgress: 0.9, quietCompletionConfidence: 0.9, quietCompletionSeconds: 0.121,
  completionSeconds: 0.08, sampleRate: 16000, sourceSampleRate: 24000, frameMs: 40,
  dimensions: 24, featureVersion: 1, fftSize: 512, windowSamples: 400,
  maxResultLagMs: 700, maxInFlight: 4, maxBatchMs: 80, maxBufferedAudioMs: 600, maxAudioGapMs: 150,
});
const DIAGNOSTIC_SETTINGS = Object.freeze({
  schemaVersion: 2, preMs: 5000, postMs: 3000, maxWindowMs: 10000,
  maxRingSamples: 160, chunkSamples: 12, chunkMs: 1000,
  summaryMs: 5000, maxTranscriptChars: 2000, maxWords: 256,
  maxPendingEvents: 5000, maxPendingBytes: 8 * 1024 * 1024, flushMs: 250,
});
const FOLLOW_SETTINGS = Object.freeze({
  versions: Object.freeze({text: 3, onset: 1, acoustic: 3, diagnostics: 2}),
  text: TEXT_SETTINGS, onset: ONSET_SETTINGS, acoustic: ACOUSTIC_SETTINGS, diagnostics: DIAGNOSTIC_SETTINGS,
});
module.exports = {TEXT_SETTINGS, ONSET_SETTINGS, ACOUSTIC_SETTINGS, DIAGNOSTIC_SETTINGS, FOLLOW_SETTINGS};
