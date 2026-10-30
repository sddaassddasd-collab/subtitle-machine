const {test} = require('node:test');
const assert = require('node:assert/strict');
const {extractFeatures, StreamingFeatures, AcousticFollower, decodeFeatures} = require('../src/acoustic-follow');
const {alignSegments, hashText, refreshMappings, isUsableSegment, validateSegmentEdit, validSegments, publicRecording} = require('../src/recordings');
const {createTracker, followTranscript, applyReferencePosition, followAudio} = require('../src/auto-follow');
const {runRecordingTask} = require('../src/recording-runtime');

const {phrasePcm,phrases} = require('./helpers/reference-audio');
const lines = [{id:'a', type:'dialogue', text:'我們今晚开始演出'}, {id:'stage', type:'direction', text:'（離場）'},
  {id:'b', type:'dialogue', text:'可是我答應過你'}];

function words(text, start = 0, step = 0.2) {
  return Array.from(text).map((word, i) => ({word, start: start + i * step, end: start + (i + 1) * step, confidence: 0.98}));
}

test('automatic cuts align traditional/simplified text in order and leave directions unmatched', () => {
  const timeline = [...words('我們今晚開始演出', 0), ...words('可是我答應過你', 2)];
  const result = alignSegments(lines, timeline, 5);
  assert.equal(result[0].status, 'auto'); assert.equal(result[0].start, 0); assert.equal(result[0].end, 1.6);
  assert.equal(result[1].status, 'direction'); assert.equal(result[1].start, null);
  assert.equal(result[2].start, 2); assert.equal(result[2].status, 'auto');
});

test('repeated phrases use surrounding cues rather than assigning the same audio span twice', () => {
  const script = ['我們走吧','先穿上外套再出門','我們走吧'].map((text,i)=>({id:String(i),type:'dialogue',text}));
  const timeline = [...words(script[0].text), ...words(script[1].text, 1), ...words(script[2].text, 3)];
  const result = alignSegments(script, timeline, 5);
  assert.equal(result[0].start, 0); assert.equal(result[2].start, 3);
  assert.ok(result[0].end <= result[1].start);
});

test('minor missing words are flagged for review; unsupported and unrecorded lines are not invented', () => {
  const script = [{id:'a',text:'今天我們要一起出門去看戲',type:'dialogue'}, {id:'b',text:'完全沒有錄到這段話',type:'dialogue'}];
  const result = alignSegments(script, words('今天我們一起出門去看戲'), 5);
  assert.equal(result[0].status, 'review'); assert.equal(result[1].status, 'unmatched');
});

test('text edits invalidate only affected audio mappings and bad manual boundaries are rejected', () => {
  const session = {lines: structuredClone(lines), recordings:[{id:'r',revision:1,segments:lines.map(line=>({lineId:line.id,textHash:hashText(line),start:0,end:1,status:'manual'}))}]};
  session.lines[0].text = '修改後的文字'; refreshMappings(session);
  assert.equal(session.recordings[0].segments[0].status, 'stale');
  assert.equal(session.recordings[0].segments[2].status, 'manual');
  assert.equal(isUsableSegment(session.recordings[0].segments[0], session.lines[0]), false);
  for (const range of [{start:-1,end:2},{start:2,end:1},{start:0,end:12},{start:0,end:0.01}])
    assert.throws(()=>validateSegmentEdit({duration:10},lines[0],range));
});

test('audio can confirm first without ASR, late text cannot rewind, and new text can still correct a skip', () => {
  const tracker = createTracker();
  const evidence = {progress:0.5,completed:false,audioStartMs:2000,audioEndMs:2600};
  assert.equal(applyReferencePosition(tracker, lines, 2, evidence), true);
  const old = followTranscript(tracker, lines, 2, {streamId:'asr',itemId:'old',text:lines[0].text,startMs:0,endMs:1000,isFinal:true});
  assert.equal(old.ignored,true); assert.equal(tracker.progressIndex,2);
  const verified = followTranscript(tracker, lines, 2, {streamId:'asr',itemId:'new',text:lines[2].text,startMs:2100,endMs:3000,isFinal:true});
  assert.equal(verified.index,2);
});

test('ASR confirmed completion is not reduced by a later partial audio match and retains silence clearing', () => {
  const tracker = createTracker();
  followTranscript(tracker, lines, 0, {streamId:'s',itemId:'a',text:lines[0].text,startMs:0,endMs:1000,isFinal:true});
  applyReferencePosition(tracker, lines, 0, {progress:0.6,completed:false,audioStartMs:0,audioEndMs:1200});
  assert.equal(tracker.progress,1);
  let result;
  for(let i=0;i<150;i++) result=followAudio(tracker,lines,0,{level:0.001,durationMs:20,endMs:1020+i*20});
  assert.equal(result.index,1); assert.equal(result.source,'silence');
});

test('an acoustically confirmed ending also arms the existing direction silence rule', () => {
  const tracker = createTracker();
  applyReferencePosition(tracker,lines,0,{progress:1,completed:true,audioStartMs:0,audioEndMs:1000});
  let result;
  for(let i=0;i<150;i++) result=followAudio(tracker,lines,0,{level:0.001,durationMs:20,endMs:1020+i*20});
  assert.equal(result.index,1); assert.equal(result.source,'silence');
});

test('feature extraction has a versioned bounded representation and worker extraction matches it', async () => {
  const pcm=phrasePcm(phrases[0]);
  const local=extractFeatures(pcm), worker=await runRecordingTask({type:'extract',pcm});
  assert.deepEqual(Buffer.from(worker.features),local.features);
  assert.equal(decodeFeatures(local.features).count,local.frameCount);
  assert.throws(()=>decodeFeatures(Buffer.from('invalid')));
  assert.ok(local.peaks.length>0);
});

test('recordings beyond the old one-hour feature cap can locate cues in the tail and still reject truncated data', () => {
  const local=extractFeatures(phrasePcm(phrases[0]));
  const prefixFrames=90025, offsetSeconds=prefixFrames*local.frameMs/1000;
  const header=Buffer.from(local.features.subarray(0,24));
  header.writeUInt32LE(prefixFrames+local.frameCount,20);
  const feature=Buffer.concat([header,Buffer.alloc(prefixFrames*25*4),local.features.subarray(24)]);
  assert.equal(decodeFeatures(feature).count,prefixFrames+local.frameCount);
  assert.throws(()=>decodeFeatures(feature.subarray(0,feature.length-4)));
  const matcher=new AcousticFollower(feature,[{lineId:'a',index:0,start:offsetSeconds,end:offsetSeconds+local.duration}]);
  const frontend=new StreamingFeatures(24000), take=phrasePcm(phrases[0],24000);
  let confirmed;
  for(let offset=0;offset+960<=take.length;offset+=960)for(const frame of frontend.push(take.subarray(offset,offset+960),(offset+960)/48)){
    const result=matcher.feed(frame,0);
    if(result?.status==='verified')confirmed=result;
  }
  assert.ok(confirmed);assert.ok(confirmed.referenceSeconds>3600);assert.equal(confirmed.lineId,'a');
});

test('different tempo, amplitude and small pitch changes still locate synthetic audio without transcription', () => {
  const referencePcm=Buffer.concat([phrasePcm(phrases[0],16000,{silence:0.4}), phrasePcm(phrases[1])]);
  const features=extractFeatures(referencePcm).features;
  const segments=[{lineId:'a',index:0,start:0,end:1.44},{lineId:'b',index:1,start:1.84,end:3.28}];
  for (const speed of [0.85,1.15]) {
    const matcher=new AcousticFollower(features,segments), frontend=new StreamingFeatures(24000);
    const take=Buffer.concat([phrasePcm(phrases[0],24000,{speed,amplitude:0.09,pitch:1.01,silence:0.4}), phrasePcm(phrases[1],24000,{speed,amplitude:0.1,pitch:1.01})]);
    let index=0, confirmed=0;
    for(let offset=0;offset+960<=take.length;offset+=960) {
      for(const frame of frontend.push(take.subarray(offset,offset+960),(offset+960)/2/24000*1000)) {
        const result=matcher.feed(frame,index);
        if(result?.status==='verified') {index=result.index;confirmed++;}
      }
    }
    assert.ok(confirmed>0,`speed ${speed}: no acoustic confirmation`);
    assert.equal(index,1,`speed ${speed}: did not enter next cue`);
  }
});

test('silence, unrelated audio and duplicate reference material do not cause audio-led cue jumps', () => {
  const pcm=phrasePcm(phrases[0],16000,{silence:0.4});
  const feature=extractFeatures(pcm).features;
  const follower=new AcousticFollower(feature,[{lineId:'a',index:0,start:0,end:1.44},{lineId:'b',index:1,start:0,end:1.44}]);
  const frontend=new StreamingFeatures(24000);
  const take=phrasePcm(phrases[0],24000);
  for(let offset=0;offset+960<=take.length;offset+=960) for(const frame of frontend.push(take.subarray(offset,offset+960),(offset+960)/48))
    assert.notEqual(follower.feed(frame,0)?.status,'verified');
});


test('an older ASR interim cannot erase an already acoustically confirmed ending', () => {
  const tracker=createTracker();
  applyReferencePosition(tracker,lines,0,{progress:1,completed:true,audioStartMs:0,audioEndMs:1600});
  const old=followTranscript(tracker,lines,0,{streamId:'s',itemId:'old',text:'我們今晚',startMs:0,endMs:800,isFinal:false});
  assert.equal(old.ignored,true);assert.equal(tracker.progress,1);assert.ok(tracker.directionWait);
});

test('provider speech onset prevents a delayed quiet-ending audio result from rearming silence clearing', () => {
  const tracker=createTracker();
  tracker.directionSpeechStartedMs=2000;
  applyReferencePosition(tracker,lines,0,{progress:1,completed:true,audioStartMs:1000,audioEndMs:2200});
  assert.equal(tracker.directionWait,null);
});

test('unrelated noise and silence cannot produce a verified acoustic jump', () => {
  const reference=extractFeatures(Buffer.concat([phrasePcm(phrases[0]),phrasePcm(phrases[1])])).features;
  const matcher=new AcousticFollower(reference,[{lineId:'a',index:0,start:0,end:1.44},{lineId:'b',index:1,start:1.44,end:2.88}]);
  const frontend=new StreamingFeatures(24000);const noise=Buffer.alloc(24000*2*3);
  let seed=12345;
  for(let i=0;i<noise.length/2;i++){seed=(1664525*seed+1013904223)>>>0;noise.writeInt16LE(Math.round(((seed/0xffffffff)*2-1)*3000),i*2);}
  for(let offset=0;offset+960<=noise.length;offset+=960)for(const frame of frontend.push(noise.subarray(offset,offset+960),(offset+960)/48))
    assert.notEqual(matcher.feed(frame,0)?.status,'verified');
  for(let i=0;i<100;i++)assert.equal(matcher.feed({feature:new Float32Array(24),rms:0,endMs:4000+i*40},0),null);
});

test('fresh confirmed text can correct an acoustic guess even if the ASR utterance began before it', () => {
  const tracker=createTracker();
  applyReferencePosition(tracker,lines,2,{progress:0.5,completed:false,audioStartMs:500,audioEndMs:1100});
  const result=followTranscript(tracker,lines,2,{streamId:'s',itemId:'new',text:lines[0].text,startMs:0,endMs:1600,isFinal:true});
  assert.equal(result.index,0);assert.equal(result.status,'corrected');assert.equal(tracker.referenceFence,null);
});

test('valid review segments participate without changing approval status; invalid/stale ranges stay excluded', () => {
  const script = Array.from({length: 7}, (_, i) => ({id: `cue-${i}`, text: `待核對的第${i}句`, type: 'dialogue'}));
  script[6].type = 'direction';
  const recording = {id: 'r', revision: 1, duration: 10, language: 'zh-TW', scriptLanguageId: 'primary', cellId: 'act',
    segments: script.map((line, i) => ({lineId: line.id, textHash: hashText(line), status: 'review', start: i, end: i + 1}))};
  recording.segments[1].end = null;
  recording.segments[2].status = 'unmatched';
  recording.segments[3].start = -1;
  recording.segments[4].end = 11;
  recording.segments[5].textHash = 'old-text';
  const session = {lines: script, selectedCellId: 'act', transcriptionLanguage: 'zh-TW', recordings: [recording]};
  assert.deepEqual(validSegments(session, recording).map(segment => segment.index), [0]);
  assert.equal(recording.segments[0].status, 'review');
  const summary = publicRecording(recording, {session});
  assert.equal(summary.usableCount, 1); assert.equal(summary.mappedCount, 0);
  script[0].text = '字幕已修改'; refreshMappings(session);
  assert.equal(recording.segments[0].status, 'stale');
  assert.equal(validSegments(session, recording).length, 0);
  script[0].text = '待核對的第0句'; refreshMappings(session);
  assert.equal(recording.segments[0].status, 'review');
  assert.equal(validSegments(session, recording).length, 1);
});

// Control cosine distance explicitly, so this tests the new acceptance range
// rather than hoping a synthetic microphone change happens to score 0.80–0.84.
function constantReference() {
  const features = Buffer.from(extractFeatures(phrasePcm(phrases[0])).features);
  for (let offset = 24; offset < features.length; offset += 25 * 4) {
    features.fill(0, offset, offset + 25 * 4);
    features.writeFloatLE(1, offset); features.writeFloatLE(0.1, offset + 24 * 4);
  }
  return features;
}
function acousticFrame(confidence, index) {
  const feature = new Float32Array(24);
  feature[0] = confidence; feature[1] = Math.sqrt(1 - confidence ** 2);
  return {feature, rms: 0.1, endMs: (index + 1) * 40};
}

test('0.82 acoustic matches need three consistent hits; subthreshold and ambiguous matches remain rejected', () => {
  for (const status of ['auto', 'review']) {
    const matcher = new AcousticFollower(constantReference(), [{lineId: 'a', index: 0, start: 0, end: 1.44, status}]);
    const results = [];
    for (let i = 0; i < 20; i++) {
      const result = matcher.feed(acousticFrame(0.82, i), 0);
      if (result) results.push(result);
    }
    assert.deepEqual(results.map(result => result.status), ['candidate', 'candidate', 'verified']);
    assert.equal(results.at(-1).diagnostics.minimumConfidence, 0.8);
    assert.equal(results.at(-1).diagnostics.requiredSupport, 3);
    assert.equal(results.at(-1).segmentStatus, status);
  }
  for (const duplicate of [false, true]) {
    const segments = [{lineId: 'a', index: 0, start: 0, end: 1.44, status: 'review'}];
    if (duplicate) segments.push({...segments[0], lineId: 'b', index: 1});
    const matcher = new AcousticFollower(constantReference(), segments);
    let last;
    for (let i = 0; i < 40; i++) last = matcher.feed(acousticFrame(duplicate ? 0.82 : 0.79, i), 0) || last;
    assert.equal(last.status, 'searching');
    assert.equal(last.reason, duplicate ? 'ambiguous' : 'below_threshold');
    assert.equal(last.diagnostics.supportCount, 0);
  }
});

test('strong review matches still require three hits and no-reference diagnostics explain the missing window', () => {
  for (const status of ['auto', 'review']) {
    const matcher = new AcousticFollower(constantReference(), [{lineId:'a',index:0,start:0,end:1.44,status}]);
    const results = [];
    for (let i = 0; i < 20; i++) {
      const result = matcher.feed(acousticFrame(0.95, i), 0);
      if (result) results.push(result.status);
    }
    assert.deepEqual(results, status === 'review' ? ['candidate','candidate','verified'] : ['candidate','verified','verified']);
  }
  const matcher = new AcousticFollower(constantReference(), [{lineId:'a',index:6,start:0,end:1.44,status:'auto'}]);
  let result;
  for (let i=0;i<12;i++) result=matcher.feed(acousticFrame(0.95,i),0) || result;
  assert.equal(result.reason,'no_usable_segments'); assert.equal(result.diagnostics.eligibleSegments,0);
});

test('a final ending before the acoustic decision cannot rewind it even if it overlaps the matching window', () => {
  const tracker=createTracker();
  applyReferencePosition(tracker,lines,2,{progress:0.5,completed:false,audioStartMs:500,audioEndMs:2600});
  const result=followTranscript(tracker,lines,2,{streamId:'s',itemId:'late',text:lines[0].text,startMs:0,endMs:1200,isFinal:true});
  assert.equal(result.ignored,true);assert.equal(tracker.progressIndex,2);
});
