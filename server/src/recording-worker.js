const {parentPort} = require('node:worker_threads');
const {extractFeatures, StreamingFeatures, AcousticFollower} = require('./acoustic-follow');
const {alignSegments} = require('./recordings');
let frontend, follower, generation;
const bytes = value => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
parentPort.on('message', message => {
  try {
    if (message.type === 'extract') {
      const result = extractFeatures(bytes(message.pcm));
      parentPort.postMessage({type: 'extracted', ...result});
    } else if (message.type === 'align') {
      parentPort.postMessage({type: 'aligned', segments: alignSegments(message.lines, message.words,
        message.duration, bytes(message.features))});
    } else if (message.type === 'configure') {
      frontend = new StreamingFeatures();
      follower = new AcousticFollower(bytes(message.features), message.segments);
      follower.reset(message.currentIndex); generation = message.generation;
      parentPort.postMessage({type: 'ready', generation});
    } else if (message.type === 'position') {
      generation = message.generation;
      frontend.reset(); follower.reset(message.currentIndex);
    } else if (message.type === 'audio' && follower && generation === message.generation) {
      let result = null;
      for (const frame of frontend.push(bytes(message.pcm), message.audioEndMs)) {
        result = follower.feed(frame, message.currentIndex) || result;
      }
      parentPort.postMessage({type: 'result', generation, sequence: message.sequence, result});
    }
  } catch (error) { parentPort.postMessage({type: 'error', error: error.message}); }
});
