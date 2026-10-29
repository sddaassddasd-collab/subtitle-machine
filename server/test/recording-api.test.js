const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const {Readable, Duplex} = require('node:stream');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-recording-test-'));
process.env.DATABASE_URL = '';
process.env.SUBTITLE_MACHINE_DATA_DIR = dataDir;
process.env.DEEPGRAM_API_KEY = 'test-only-not-a-real-key';
const persistence = require('../src/persistence');
const {phrasePcm, phrases} = require('./helpers/reference-audio');
const {hashText} = require('../src/recordings');
const {extractFeatures} = require('../src/acoustic-follow');
const {runRecordingTask} = require('../src/recording-runtime');
const {pack, unpack, CHUNK_SECONDS} = require('../src/local-recording-routes');

function wav(pcm, sampleRate = 16000) {
  const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36,4);
  header.write('WAVEfmt ',8); header.writeUInt32LE(16,16); header.writeUInt16LE(1,20); header.writeUInt16LE(1,22);
  header.writeUInt32LE(sampleRate,24); header.writeUInt32LE(sampleRate*2,28); header.writeUInt16LE(2,32); header.writeUInt16LE(16,34);
  header.write('data',36); header.writeUInt32LE(pcm.length,40); return Buffer.concat([header,pcm]);
}
const waitFor = async predicate => {
  for (let i=0;i<300;i++) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,10)); }
  throw new Error('Timed out waiting for recording job/worker');
};

function fixture({recordingTask, recordingStorage, recordingRequest} = {}) {
  const filename = require.resolve('../src/server');
  let source = fs.readFileSync(filename,'utf8');
  source = source.replace('  broadcast: broadcastControlState,', `  broadcast: broadcastControlState,
    task: module.recordingTask, storage: module.recordingStorage,
    request: module.recordingRequest || (async () => ({ok: true, json: async () => ({results: {channels: [{alternatives: [{words: [
      {word:'我們今晚開始演出',start:0,end:1.44,confidence:0.99},
      {word:'可是我答應過你',start:1.84,end:3.28,confidence:0.99},
    ]}]}]}})})),`);
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded.recordingTask=recordingTask;loaded.recordingStorage=recordingStorage;
  loaded.recordingRequest=recordingRequest;
  loaded._compile(source.replace(/startServer\(\);\s*$/, `
    module.exports = () => {
      const user={id:'reference-api-owner',role:USER_ROLES.OPERATOR}; users.set(user.id,user);
      const cookieToken='reference-api-token'; authSessions.set(hashToken(cookieToken),{tokenHash:hashToken(cookieToken),userId:user.id,expiresAt:Date.now()+60000});
      const session=createSessionRecord(user.id);
      session.cells[0].lines=[createLineRecord({id:'a',text:'我們今晚開始演出'}),createLineRecord({id:'direction',type:'direction',text:'（離場）'}),createLineRecord({id:'b',text:'可是我答應過你'})];
      syncSelectedCellLines(session); sessions.set(session.id,session);
      persistApplicationStore=async()=>{}; persistSession=s=>storeSessionInMemory(s);
      const stream={provider:'deepgram',socketId:'reference-test-socket',ready:true,closing:false,autoFollowAudioMs:0,
        liveTranslationStreamId:'recording-live', pendingAudioChunks:[], socket:{readyState:1,bufferedAmount:0,send(){},close(){this.readyState=3}}};
      transcriptionStreams.set(session.id,stream);
      const handlers=new Map();io.listeners('connection')[0]({id:stream.socketId,data:{},handshake:{headers:{cookie:AUTH_COOKIE_NAME+'='+cookieToken}},on:(event,handler)=>handlers.set(event,handler),emit(){}});
      return {app,session,stream,cookie:AUTH_COOKIE_NAME+'='+cookieToken, runtime:referenceRuntime, history:autoFollowHistory,
        state:()=>getPublicAutoFollowState(session), viewer:()=>getViewerPayload(session),
        transcript:(text,options)=>handleAutoFollowTranscript(session.id,text,options),
        audioResult: result=>handleReferenceAudioResult(session.id,result),
        socket:(name,payload)=>{let reply;handlers.get(name)(payload,value=>{reply=value});return reply;},
        changePerformanceLanguage:language=>{session.transcriptionLanguage=language;syncPerformanceFollowing(session);},
        idle:()=>{transcriptionStreams.delete(session.id);},
        store:()=>serializeSessionForStorage(session), reload:s=>ensureSessionStructure(s),
        send(payload) {let reply;handlers.get('transcription:audio')({sessionId:session.id,...payload},value=>{reply=value});return reply;},
        dispose(){referenceRuntime.dispose();recordingRoutes.cancelSession(session.id);for(const timer of currentIndexPersistTimers.values())clearTimeout(timer);for(const timer of latestRoomStateKeyframes.values())clearTimeout(timer);}
      };
    };
  `),filename);
  return loaded.exports();
}

function addEnglish(f) {
  f.session.languages.push({id:'english',name:'English',code:'en'});
  f.session.lines[0].translations.english='We begin the show tonight';
  f.session.lines[2].translations.english='But I promised you';
}
function languageRequest(calls) {
  return async url=>{
    const language=new URL(url).searchParams.get('language');calls.push(language);
    const text=language==='en'?['We begin the show tonight','But I promised you']:['我們今晚開始演出','可是我答應過你'];
    return {ok:true,json:async()=>({results:{channels:[{alternatives:[{words:text.map((word,index)=>({word,start:index*1.84,end:index*1.84+1.44,confidence:.99}))}]}]}})};
  };
}

// Exercise the real Express auth, multipart parser and routes with Node HTTP
// objects, without listening on a port or contacting a transcription provider.
async function request(f, route, {method='GET', body, bodyStream, cookie=f.cookie, headers={}}={}) {
  let bytes=Buffer.alloc(0);
  if(body instanceof FormData) {
    const encoded=new Request('http://test.invalid/',{method:'POST',body});
    bytes=Buffer.from(await encoded.arrayBuffer());headers['content-type']=encoded.headers.get('content-type');
  } else if(body instanceof Uint8Array) {bytes=Buffer.from(body);}
  else if(body) {bytes=Buffer.from(JSON.stringify(body));headers['content-type']='application/json';}
  const req=Readable.from(bodyStream || (bytes.length?[bytes]:[]));Object.assign(req,{method,url:route,originalUrl:route,headers:{...headers,cookie,'content-length':headers['content-length'] || String(bytes.length)},httpVersion:'1.0',httpVersionMajor:1,httpVersionMinor:0});
  const chunks=[];
  const socket=new Duplex({read(){},write(chunk,_encoding,callback){chunks.push(Buffer.from(chunk));callback();}});
  socket.remoteAddress='127.0.0.1';req.socket=socket;req.connection=socket;
  const res=new http.ServerResponse(req);res.assignSocket(socket);
  const finished=new Promise((resolve,reject)=>{res.on('finish',resolve);res.on('error',reject);});
  f.app.handle(req,res);await finished;
  const raw=Buffer.concat(chunks), separator=raw.indexOf('\r\n\r\n');
  const payload=raw.subarray(separator+4);
  return {status:res.statusCode,headers:res.getHeaders(),bytes:payload,json:()=>JSON.parse(payload.toString())};
}

// Stream padding in small reused chunks: test the real multipart parser without
// constructing several full copies of a one-hour decoded PCM payload.
function streamedUpload(audio, {audioBytes=audio.length, pcm=Buffer.alloc(2), pcmBytes=pcm.length}={}) {
  const boundary='reference-audio-test-boundary';
  const first=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="test.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const middle=Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="pcm"; filename="test.pcm"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const last=Buffer.from(`\r\n--${boundary}--\r\n`), padding=Buffer.alloc(65536);
  function* padded(prefix, length) {
    yield prefix;
    for(let remaining=length-prefix.length;remaining>0;remaining-=padding.length) yield padding.subarray(0,Math.min(remaining,padding.length));
  }
  return {method:'POST',headers:{'content-type':`multipart/form-data; boundary=${boundary}`,
    'content-length':String(first.length+audioBytes+middle.length+pcmBytes+last.length)},
    bodyStream:(function*(){yield first;yield* padded(audio,audioBytes);yield middle;yield* padded(pcm,pcmBytes);yield last;})()};
}
async function importRecording(f) {
  const pcm=Buffer.concat([phrasePcm(phrases[0],16000,{silence:0.4}),phrasePcm(phrases[1])]);
  const body=new FormData();body.append('audio',new Blob([wav(pcm)],{type:'audio/wav'}),'test.wav');body.append('pcm',new Blob([pcm]),'test.pcm');
  const response=await request(f,`/api/session/${f.session.id}/recordings`,{method:'POST',body});
  assert.equal(response.status,202,response.bytes.toString());
  await waitFor(()=>f.session.recordings[0]?.status==='ready');
  assert.equal(f.session.recordings[0].error,'');
  const active=await request(f,`/api/session/${f.session.id}/recordings/active`,{method:'PUT',body:{recordingId:f.session.recordings[0].id}});
  assert.equal(active.status,200);
  return f.session.recordings[0];
}

test('upload, automatic cuts, waveform, protected ranged playback, manual correction and durable asset storage', async t=>{
  const f=fixture();t.after(()=>f.dispose());
  const recording=await importRecording(f),base=`/api/session/${f.session.id}/recordings/${recording.id}`;
  assert.equal(recording.segments[0].status,'auto');assert.equal(recording.segments[1].status,'direction');
  assert.equal(f.session.activeRecordingId,recording.id);
  const waveform=await request(f,base+'/waveform');assert.equal(waveform.json().featuresReady,true);assert.ok(waveform.json().peaks.length);
  const range=await request(f,base+'/audio',{headers:{range:'bytes=0-43'}});assert.equal(range.status,206);assert.equal(range.bytes.length,44);assert.equal(range.bytes.toString('ascii',0,4),'RIFF');
  assert.equal((await request(f,base+'/audio',{cookie:''})).status,401);
  assert.equal((await request(f,base+'/audio',{headers:{range:'bytes=99999999-'}})).status,416);
  const correction=await request(f,base+'/segments/a',{method:'PUT',body:{start:0.1,end:1.3}});assert.equal(correction.status,200);assert.equal(correction.json().segment.status,'manual');
  assert.equal((await request(f,base+'/segments/a',{method:'PUT',body:{start:-1,end:1}})).status,400);
  const restored=f.reload(JSON.parse(JSON.stringify(f.store())));assert.equal(restored.recordings[0].segments.find(s=>s.lineId==='a').start,0.1);
  const asset=await persistence.getRecordingAsset(f.session.id,recording.id,{audio:true,pcm:true});assert.ok(asset.audio.length);assert.ok(asset.features.length);assert.equal(asset.pcm,null);assert.ok(asset.analysis.words.length);
  const deletion=await request(f,base,{method:'DELETE'});assert.equal(deletion.status,200);assert.equal(f.session.recordings.length,0);assert.equal(await persistence.getRecordingAsset(f.session.id,recording.id),null);
});

test('multipart accepts decoded PCM beyond one hour and scales analysis deadlines without a duration limit',async t=>{
  const duration=3701, pcmBytes=duration*16000*2, prefix=phrasePcm(phrases[0]);
  const deadlines=[];
  const f=fixture({recordingStorage:{
    async putRecordingAsset(_sessionId,_recordingId,asset){assert.equal(asset.pcm.length,pcmBytes);},
    async updateRecordingAnalysis(){},
  },recordingTask:async(message,timeout,signal)=>{
    deadlines.push(timeout);
    if(message.type==='extract'){
      assert.equal(message.pcm.length,pcmBytes);
      // Only upload acceptance is under test here; tail matching has its own
      // real acoustic regression, so avoid extracting an hour of silent padding.
      return extractFeatures(prefix);
    }
    return runRecordingTask(message,timeout,signal);
  }});t.after(()=>f.dispose());
  const base=`/api/session/${f.session.id}/recordings`;
  const response=await request(f,base,streamedUpload(wav(prefix),{pcm:prefix,pcmBytes}));
  assert.equal(response.status,202,response.bytes.toString());
  await waitFor(()=>f.session.recordings[0]?.status==='ready');
  assert.equal(f.session.recordings[0].duration,duration);assert.equal(f.session.recordings[0].error,'');
  assert.deepEqual(deadlines,[duration*100,duration*100]);
  assert.equal((await request(f,base)).json().limits.maxDuration,null);
});

test('the source audio byte limit is enforced while streaming independently of decoded PCM size',async t=>{
  const f=fixture();t.after(()=>f.dispose());
  const response=await request(f,`/api/session/${f.session.id}/recordings`,streamedUpload(Buffer.alloc(2),{audioBytes:128*1024*1024+1}));
  assert.equal(response.status,400);assert.equal(f.session.recordings.length,0);
});

test('recordings are isolated between owners and a different scene cannot be activated',async t=>{
  const f=fixture();t.after(()=>f.dispose());const r=await importRecording(f);
  f.session.ownerUserId='another-owner';assert.equal((await request(f,`/api/session/${f.session.id}/recordings`)).status,404);
  f.session.ownerUserId='reference-api-owner';r.cellId='another-cell';
  assert.equal((await request(f,`/api/session/${f.session.id}/recordings/active`,{method:'PUT',body:{recordingId:r.id}})).status,400);
  await persistence.deleteRecordingAssets(f.session.id);
});

test('switching scenes during analysis keeps cuts and later edits tied to the recorded scene',async t=>{
  const f=fixture();t.after(()=>f.dispose());
  const originalCellId=f.session.cells[0].id;
  const otherCell={id:'other-scene',lines:[{id:'other-line',type:'dialogue',text:'另一個場次的台詞'}]};
  f.session.cells.push(otherCell);
  const pcm=Buffer.concat([phrasePcm(phrases[0],16000,{silence:.4}),phrasePcm(phrases[1])]);
  const body=new FormData();body.append('audio',new Blob([wav(pcm)],{type:'audio/wav'}),'scene.wav');body.append('pcm',new Blob([pcm]),'scene.pcm');
  const base=`/api/session/${f.session.id}/recordings`;
  assert.equal((await request(f,base,{method:'POST',body})).status,202);
  f.session.selectedCellId=otherCell.id;f.session.lines=otherCell.lines;
  await waitFor(()=>f.session.recordings[0]?.status==='ready');
  const r=f.session.recordings[0];
  assert.equal(r.cellId,originalCellId);assert.deepEqual(r.segments.map(s=>s.lineId),['a','direction','b']);
  assert.equal(r.segments[0].status,'auto');assert.equal(r.segments[2].status,'auto');
  const revision=r.revision;
  await request(f,base);assert.equal(r.revision,revision);
  assert.equal((await request(f,base+'/active',{method:'PUT',body:{recordingId:r.id}})).status,400);
  const originalText=f.session.cells.find(cell=>cell.id===originalCellId).lines[0].text;
  f.session.cells.find(cell=>cell.id===originalCellId).lines[0].text='其他修改';
  await request(f,base);assert.equal(r.segments[0].status,'stale');assert.equal(r.segments[2].status,'auto');
  f.session.cells.find(cell=>cell.id===originalCellId).lines[0].text=originalText;
  await request(f,base);assert.equal(r.segments[0].status,'auto');
  assert.equal((await request(f,`${base}/${r.id}/segments/a`,{method:'PUT',body:{start:0,end:1.4}})).status,200);
  assert.equal((await request(f,`${base}/${r.id}/segments/other-line`,{method:'PUT',body:{start:0,end:1.4}})).status,400);
  f.session.selectedCellId=originalCellId;f.session.lines=f.session.cells.find(cell=>cell.id===originalCellId).lines;
  assert.equal((await request(f,base+'/active',{method:'PUT',body:{recordingId:r.id}})).status,200);
  await persistence.deleteRecordingAssets(f.session.id);
});

test('text can advance immediately; delayed audio for the same/older cue cannot double-advance or rewind',async t=>{
  const f=fixture();t.after(()=>f.dispose());const r=await importRecording(f);f.session.subtitleControlMode='auto';
  await f.runtime.ensure(f.session);await waitFor(()=>f.runtime.sessions.get(f.session.id)?.ready);
  f.stream.autoFollowAudioMs=2500;
  f.transcript('可是我答應過你',{streamId:'recording-live',itemId:'text-first',startMs:1500,endMs:2500,isFinal:true});
  assert.equal(f.session.currentIndex,2);assert.equal(f.state().lastDecision.source,'transcript');
  const entry=f.runtime.sessions.get(f.session.id);
  const same={recordingId:r.id,revision:r.revision,generation:entry.generation,status:'verified',lineId:'b',progress:0.6,confidence:.99,audioStartMs:1500,audioEndMs:2000};
  f.audioResult(same);assert.equal(f.session.currentIndex,2);assert.equal(f.state().lastDecision.source,'transcript');
  f.audioResult({...same,lineId:'a',audioEndMs:2600});assert.equal(f.session.currentIndex,2);
  await persistence.deleteRecordingAssets(f.session.id);
});

test('real acoustic worker can lead cue changes while ASR stream remains active',async t=>{
  const f=fixture();t.after(()=>f.dispose());const r=await importRecording(f);f.session.subtitleControlMode='auto';
  const historyId = await f.history.start(f.session);
  t.after(() => f.history.end(f.session.id));
  await f.runtime.ensure(f.session);await waitFor(()=>f.runtime.sessions.get(f.session.id)?.ready);
  const take=Buffer.concat([phrasePcm(phrases[0],24000,{speed:0.85,amplitude:0.1,pitch:1.01,silence:.4}),phrasePcm(phrases[1],24000,{speed:0.85,amplitude:0.1,pitch:1.01})]);
  let sequence=0;
  for(let offset=0;offset+960<=take.length;offset+=960){
    const reply = f.send({audio:take.subarray(offset,offset+960).toString('base64'),durationMs:20,level:.04,sequence:++sequence});
    assert.equal(reply.ok,true,JSON.stringify(reply));
    await new Promise(resolve=>setTimeout(resolve,3));
  }
  await waitFor(()=>f.session.currentIndex===2);
  assert.equal(f.state().lastDecision.source,'audio');assert.equal(f.viewer().text,'可是我答應過你');
  const traced = (await request(f, `/api/session/${f.session.id}/follow-history/${historyId}`)).json();
  assert.equal(traced.rows[2].visits[0].source, 'audio');
  assert.equal(traced.rows[2].visits[0].confirmations[0].source, 'audio');
  assert.equal(traced.rows[2].reference.usable, true);
  assert.equal(f.stream.ready,true);assert.equal(f.stream.closing,false);
  await persistence.deleteRecordingAssets(f.session.id,r.id);
});

test('cached transcription can be realigned without another provider key and undoing text restores the original mapping',async t=>{
  const f=fixture();t.after(()=>f.dispose());const r=await importRecording(f),base=`/api/session/${f.session.id}/recordings/${r.id}`;
  const correction=await request(f,base+'/segments/a',{method:'PUT',body:{start:0.1,end:1.3}});assert.equal(correction.status,200);
  const key=process.env.DEEPGRAM_API_KEY;delete process.env.DEEPGRAM_API_KEY;
  try{
    const response=await request(f,base+'/align',{method:'POST'});assert.equal(response.status,202);
    const revision=r.revision;
    await waitFor(()=>r.status==='ready'&&r.revision>revision);
    assert.equal(r.error,'');assert.equal(r.segments.find(s=>s.lineId==='a').status,'manual');
    assert.equal(r.segments.find(s=>s.lineId==='a').start,0.1);
  }finally{process.env.DEEPGRAM_API_KEY=key;}
  const original=f.session.lines[0].text;
  f.session.lines[0].text='修改台詞';
  await request(f,`/api/session/${f.session.id}/recordings`);
  assert.equal(r.segments.find(s=>s.lineId==='a').status,'stale');
  f.session.lines[0].text=original;
  await request(f,`/api/session/${f.session.id}/recordings`);
  assert.equal(r.segments.find(s=>s.lineId==='a').status,'manual');
  await persistence.deleteRecordingAssets(f.session.id);
});

test('without a transcription key import still preserves playable audio and manual calibration can enable following',async t=>{
  const key=process.env.DEEPGRAM_API_KEY;delete process.env.DEEPGRAM_API_KEY;
  const f=fixture();t.after(()=>f.dispose());
  try{
    const pcm=phrasePcm(phrases[0]);const body=new FormData();
    body.append('audio',new Blob([wav(pcm)],{type:'audio/wav'}),'manual.wav');body.append('pcm',new Blob([pcm]),'manual.pcm');
    const base=`/api/session/${f.session.id}/recordings`;
    assert.equal((await request(f,base,{method:'POST',body})).status,202);
    await waitFor(()=>f.session.recordings[0]?.status==='ready');const r=f.session.recordings[0];
    assert.match(r.error,/金鑰/);assert.equal(r.segments[0].status,'unmatched');
    assert.equal((await request(f,base+'/active',{method:'PUT',body:{recordingId:r.id}})).status,400);
    assert.equal((await request(f,base+`/${r.id}/segments/a`,{method:'PUT',body:{start:0,end:1.4}})).status,200);
    assert.equal((await request(f,base+'/active',{method:'PUT',body:{recordingId:r.id}})).status,200);
    assert.equal((await request(f,base+`/${r.id}/audio`)).status,200);
    await persistence.deleteRecordingAssets(f.session.id);
  }finally{process.env.DEEPGRAM_API_KEY=key;}
});

test('English performance follows its translation column while viewer output remains Chinese and old-language results are ignored',async t=>{
  const f=fixture();t.after(()=>f.dispose());addEnglish(f);
  f.session.subtitleControlMode='auto';f.changePerformanceLanguage('en');f.stream.language='en';
  f.stream.autoFollowAudioMs=1600;
  f.transcript('But I promised you',{language:'en',streamId:'recording-live',itemId:'english',startMs:0,endMs:1600,isFinal:true});
  assert.equal(f.session.currentIndex,2);assert.equal(f.viewer().text,'可是我答應過你');
  assert.equal(f.state().lastCandidateText,'But I promised you');assert.equal(f.state().followingScript.languageId,'english');
  f.transcript('We begin the show tonight',{language:'en',streamId:'previous-ASR-connection',itemId:'late-old-stream',startMs:1700,endMs:2200,isFinal:true});
  assert.equal(f.session.currentIndex,2);assert.equal(f.state().lastHeardText,'But I promised you');
  f.changePerformanceLanguage('zh-TW');
  f.transcript('We begin the show tonight',{language:'en',streamId:'recording-live',itemId:'late-English',startMs:1700,endMs:2200,isFinal:true});
  assert.equal(f.session.currentIndex,2);assert.equal(f.state().lastHeardText,'');
});

test('explicit script bindings persist and changing a binding fences the prior cue and disables incompatible audio',async t=>{
  const f=fixture();t.after(()=>f.dispose());addEnglish(f);const recording=await importRecording(f);
  f.session.subtitleControlMode='auto';f.stream.autoFollowAudioMs=2000;
  assert.equal(f.socket('transcription:set-script-language',{sessionId:f.session.id,language:'en',languageId:'english'}).ok,false);
  const reply=f.socket('transcription:set-script-language',{sessionId:f.session.id,language:'zh-TW',languageId:'english'});
  assert.equal(reply.ok,true);assert.equal(f.session.activeRecordingId,null);
  assert.equal(f.store().followingLanguageIds['zh-TW'],'english');
  f.transcript('But I promised you',{streamId:'recording-live',itemId:'old-column',startMs:0,endMs:1000,isFinal:true});
  assert.equal(f.session.currentIndex,0);
  assert.equal((await request(f,`/api/session/${f.session.id}/recordings/active`,{method:'PUT',body:{recordingId:recording.id}})).status,400);
  f.idle();f.socket('transcription:set-language',{sessionId:f.session.id,language:'en'});
  assert.equal(f.session.transcriptionLanguage,'en');assert.equal(f.state().followingScript.languageId,'english');
  await persistence.deleteRecordingAssets(f.session.id);
});

test('an English recording uses English ASR and cuts, preserves features on language correction and never reuses another language cache',async t=>{
  const calls=[], f=fixture({recordingRequest:languageRequest(calls)});t.after(()=>f.dispose());addEnglish(f);
  const r=await importRecording(f),base=`/api/session/${f.session.id}/recordings/${r.id}`;
  const features=(await persistence.getRecordingAsset(f.session.id,r.id)).features;
  assert.equal((await request(f,base+'/language',{method:'PUT',body:{language:'en'}})).status,202);
  await waitFor(()=>r.status==='ready');
  assert.deepEqual(calls,['zh-TW','en']);assert.equal(r.language,'en');assert.equal(r.scriptLanguageId,'english');
  assert.equal(r.segments.find(segment=>segment.lineId==='a').status,'auto');
  assert.equal(r.segments.find(segment=>segment.lineId==='a').textHash,hashText({...f.session.lines[0],text:'We begin the show tonight'}));
  assert.deepEqual((await persistence.getRecordingAsset(f.session.id,r.id)).features,features);
  assert.equal((await request(f,`/api/session/${f.session.id}/recordings/active`,{method:'PUT',body:{recordingId:r.id}})).status,400);
  f.changePerformanceLanguage('en');
  assert.equal((await request(f,`/api/session/${f.session.id}/recordings/active`,{method:'PUT',body:{recordingId:r.id}})).status,200);
  const revision=r.revision;
  assert.equal((await request(f,base+'/align',{method:'POST'})).status,202);
  await waitFor(()=>r.status==='ready'&&r.revision>revision+1);assert.deepEqual(calls,['zh-TW','en']);
  const key=process.env.DEEPGRAM_API_KEY;delete process.env.DEEPGRAM_API_KEY;
  try{
    assert.equal((await request(f,base+'/language',{method:'PUT',body:{language:'zh-TW'}})).status,202);
    await waitFor(()=>r.status==='ready');assert.match(r.error,/金鑰/);assert.equal(r.segments[0].status,'unmatched');
    assert.deepEqual(calls,['zh-TW','en']);assert.equal(f.session.activeRecordingId,null);
  }finally{process.env.DEEPGRAM_API_KEY=key;}
  await persistence.deleteRecordingAssets(f.session.id);
});

test('import language can be selected independently and missing language text is reported without primary-column fallback',async t=>{
  const calls=[],f=fixture({recordingRequest:languageRequest(calls)});t.after(()=>f.dispose());addEnglish(f);
  const pcm=phrasePcm(phrases[0]),body=new FormData();
  body.append('audio',new Blob([wav(pcm)],{type:'audio/wav'}),'english.wav');body.append('pcm',new Blob([pcm]),'test.pcm');body.append('language','en');
  assert.equal((await request(f,`/api/session/${f.session.id}/recordings`,{method:'POST',body})).status,202);
  await waitFor(()=>f.session.recordings[0]?.status==='ready');const r=f.session.recordings[0];
  assert.equal(r.language,'en');assert.equal(f.session.transcriptionLanguage,'zh-TW');assert.deepEqual(calls,['en']);
  f.session.languages=f.session.languages.filter(language=>language.id!=='english');f.changePerformanceLanguage('en');
  assert.equal(f.state().followingScript.available,false);assert.match(f.state().followingScript.message,/劇本欄/);
  f.session.subtitleControlMode='auto';f.stream.autoFollowAudioMs=1000;
  f.transcript('可是我答應過你',{language:'en',streamId:'recording-live',itemId:'wrong-column',startMs:0,endMs:1000,isFinal:true});
  assert.equal(f.session.currentIndex,0);
  await persistence.deleteRecordingAssets(f.session.id);
});

async function createLocal(f, duration=1.44, extra={}) {
  const response=await request(f,`/api/session/${f.session.id}/recordings/local`,{method:'POST',body:{
    name:'local.mp3',mime:'audio/mpeg',duration,byteLength:173000000,fingerprint:'a'.repeat(64),...extra}});
  assert.ok([200,201].includes(response.status),response.bytes.toString());
  return response.json().recording;
}
function localChunk(recording,index,{words=[],transcribed=true,revision=recording.localRevision}={}) {
  const start=index*CHUNK_SECONDS,end=Math.min(recording.duration,start+CHUNK_SECONDS);
  const samples=Math.round((end-start)*16000),count=Math.max(0,Math.floor((samples-400)/640)+1);
  const features=Buffer.alloc(24+count*100);features.write('RFA1');
  [1,16000,40,24,count].forEach((value,i)=>features.writeUInt32LE(value,4+i*4));
  return pack({fingerprint:recording.fingerprint,language:recording.language,localRevision:revision,
    words,transcribed,peaks:new Array(Math.ceil(samples/1600)).fill(0.25)},features);
}
const chunkRequest = body => ({method:'PUT',body,headers:{'content-type':'application/octet-stream'}});

test('over three hours of local analysis resumes by chunk, restores from a portable backup and follows without a source audio asset',async t=>{
  const f=fixture();t.after(()=>f.dispose());
  const r=await createLocal(f,10801.44),base=`/api/session/${f.session.id}/recordings/${r.id}`;
  const total=Math.ceil(r.duration/CHUNK_SECONDS);
  for(let i=0;i<total;i++) {
    const words=i===0?[{word:'我們今晚開始演出',start:0,end:1.44,confidence:.99}]
      :i===total-1?[{word:'可是我答應過你',start:r.duration-1.44,end:r.duration,confidence:.99}]:[];
    const response=await request(f,`${base}/local/chunks/${i}`,chunkRequest(localChunk(r,i,{words})));
    assert.equal(response.status,200,response.bytes.toString());
    if(i===0) {
      const state=(await request(f,`${base}/local/state`)).json();
      assert.deepEqual(state.completed,[{index:0,transcribed:true}]);
      assert.equal((await request(f,`${base}/local/chunks/0`,chunkRequest(localChunk(r,0,{words})))).status,200);
    }
  }
  assert.equal((await request(f,`${base}/local/state`)).json().completed.length,total);
  assert.equal((await request(f,`${base}/local/finish`,{method:'POST'})).status,202);
  await waitFor(()=>f.session.recordings[0].status==='ready');
  const asset=await persistence.getRecordingAsset(f.session.id,r.id,{audio:true,pcm:true});
  assert.equal(asset.audio,null);assert.equal(asset.pcm,null);
  assert.ok(asset.features.length>27e6);assert.equal(asset.analysis.words.length,2);
  assert.ok(f.session.recordings[0].segments.find(s=>s.lineId==='b').start>=10800);
  assert.equal((await request(f,`${base}/audio`)).status,404);
  const waveform=(await request(f,`${base}/waveform?start=10800&end=10801.44`)).json();
  assert.equal(waveform.peakSeconds,.1);assert.ok(waveform.peaks.length<20);
  const active=await request(f,`/api/session/${f.session.id}/recordings/active`,{method:'PUT',body:{recordingId:r.id}});
  assert.equal(active.status,200);await f.runtime.ensure(f.session);await waitFor(()=>f.runtime.sessions.get(f.session.id)?.ready);
  const backup=await request(f,`${base}/local/export`);assert.equal(backup.status,200);
  assert.equal(unpack(backup.bytes,20*1024*1024).metadata.kind,'subtitle-local-recording');
  assert.equal((await request(f,base,{method:'DELETE'})).status,200);
  assert.equal((await persistence.getRecordingChunks(f.session.id,r.id)).length,0);
  const imported=await request(f,`/api/session/${f.session.id}/recordings/local/import`,{
    method:'POST',body:backup.bytes,headers:{'content-type':'application/octet-stream'}});
  assert.equal(imported.status,201,imported.bytes.toString());assert.equal(imported.json().recording.mappedCount,2);
  const restored=await persistence.getRecordingAsset(f.session.id,imported.json().recording.id,{audio:true});
  assert.equal(restored.audio,null);assert.equal(restored.features.length,asset.features.length);
});

test('local chunks reject foreign, malformed and stale data; language correction fences old uploads',async t=>{
  const f=fixture();t.after(()=>f.dispose());const r=await createLocal(f);
  const base=`/api/session/${f.session.id}/recordings/${r.id}`;
  assert.equal((await request(f,base+'/local/chunks/0',{...chunkRequest(localChunk(r,0)),cookie:''})).status,401);
  f.session.ownerUserId='other';assert.equal((await request(f,base+'/local/state')).status,404);f.session.ownerUserId='reference-api-owner';
  assert.equal((await request(f,base+'/local/chunks/1',chunkRequest(localChunk(r,0)))).status,400);
  const corrupt=localChunk(r,0);corrupt.writeFloatLE(NaN,corrupt.length-4);
  assert.equal((await request(f,base+'/local/chunks/0',chunkRequest(corrupt))).status,400);
  assert.equal((await request(f,base+'/local/chunks/0',chunkRequest(localChunk(r,0,{revision:999})))).status,400);
  assert.equal((await request(f,base+'/local/chunks/0',chunkRequest(localChunk(r,0)))).status,200);
  const language=await request(f,base+'/language',{method:'PUT',body:{language:'en'}});
  assert.equal(language.status,200);assert.equal(language.json().recording.localRevision,2);
  assert.equal((await request(f,base+'/local/state')).json().completed.length,0);
  assert.equal((await request(f,base+'/local/chunks/0',chunkRequest(localChunk(r,0)))).status,400);
  assert.equal((await persistence.getRecordingAsset(f.session.id,r.id,{audio:true})).audio,null);
});

test('local token grants remain server-authenticated, short-lived, rate-limited and never expose the provider key',async t=>{
  let calls=0;
  const f=fixture({recordingRequest:async(url,options)=>{
    calls++;assert.equal(url,'https://api.deepgram.com/v1/auth/grant');
    assert.equal(JSON.parse(options.body).ttl_seconds,120);
    assert.equal(options.headers.Authorization,'Token test-only-not-a-real-key');
    return {ok:true,json:async()=>({access_token:'temporary-test-token',expires_in:120})};
  }});t.after(()=>f.dispose());const r=await createLocal(f),base=`/api/session/${f.session.id}/recordings/${r.id}`;
  for(let i=0;i<12;i++) {
    const response=await request(f,base+'/local/token',{method:'POST'});
    assert.equal(response.status,200);assert.equal(response.json().token,'temporary-test-token');
    assert.equal(response.headers['cache-control'],'no-store');assert.ok(!response.bytes.includes('test-only-not-a-real-key'));
  }
  assert.equal((await request(f,base+'/local/token',{method:'POST'})).status,400);assert.equal(calls,12);
});

test('browser and server feature extractors produce identical bytes including chunk boundaries',async()=>{
  const {extractFeatures:browserExtract}=await import('../../client/src/lib/recording-features.js');
  const samples=Buffer.concat([phrasePcm(phrases[0]),phrasePcm(phrases[1])]);
  const typed=new Int16Array(samples.buffer,samples.byteOffset,samples.length/2);
  assert.deepEqual(Buffer.from(browserExtract(typed).features),extractFeatures(samples).features);
  const split=640*30;
  const first=Buffer.from(browserExtract(typed.subarray(0,split)).features);
  const last=Buffer.from(browserExtract(typed.subarray(split)).features);
  const header=Buffer.from(first.subarray(0,24));header.writeUInt32LE(first.readUInt32LE(20)+last.readUInt32LE(20),20);
  assert.deepEqual(Buffer.concat([header,first.subarray(24),last.subarray(24)]),extractFeatures(samples).features);
});

test('a local recording realigns cached results without contacting Deepgram; a corrupt backup cannot replace its asset',async t=>{
  let calls=0;const f=fixture({recordingRequest:async()=>{calls++;throw new Error('must not call provider');}});
  t.after(()=>f.dispose());const r=await createLocal(f),base=`/api/session/${f.session.id}/recordings/${r.id}`;
  const words=[{word:'我們今晚開始演出',start:0,end:1.44,confidence:.99}];
  assert.equal((await request(f,base+'/local/chunks/0',chunkRequest(localChunk(r,0,{words})))).status,200);
  await request(f,base+'/local/finish',{method:'POST'});await waitFor(()=>f.session.recordings[0].status==='ready');
  const revision=f.session.recordings[0].revision;
  assert.equal((await request(f,base+'/align',{method:'POST'})).status,202);
  await waitFor(()=>f.session.recordings[0].status==='ready'&&f.session.recordings[0].revision>revision+1);
  assert.equal(calls,0);
  const backup=unpack((await request(f,base+'/local/export')).bytes,20*1024*1024);
  backup.metadata.recording.segments.find(segment=>segment.lineId==='a').end=-1;
  const response=await request(f,`/api/session/${f.session.id}/recordings/local/import`,{
    method:'POST',body:pack(backup.metadata,backup.features),headers:{'content-type':'application/octet-stream'}});
  assert.equal(response.status,400);assert.equal(f.session.recordings[0].segments.find(segment=>segment.lineId==='a').end,1.44);
  assert.equal((await persistence.getRecordingAsset(f.session.id,r.id)).analysis.words[0].word,words[0].word);
});

test('word inspection and time correction preserve source timestamps and manually locked segments', async t => {
  const f = fixture(); t.after(() => f.dispose()); const r = await importRecording(f);
  const base = `/api/session/${f.session.id}/recordings/${r.id}`;
  assert.equal((await request(f, base + '/transcript', {cookie: ''})).status, 401);
  const initial = (await request(f, base + '/transcript?lineId=a')).json();
  assert.equal(initial.words[0].id, 0); assert.equal(initial.words[0].rawStart, 0);
  await request(f, base + '/segments/a', {method: 'PUT', body: {start: 0.1, end: 1.3}});
  const originalWords = (await persistence.getRecordingAsset(f.session.id, r.id)).analysis.words;
  const revision = r.revision;
  const response = await request(f, base + '/timing', {method: 'PUT', body: {anchors: [{wordId: 0, time: 0.2}], playerDuration: r.duration + .2}});
  assert.equal(response.status, 202, response.bytes.toString());
  await waitFor(() => r.status === 'ready' && r.revision >= revision + 2);
  assert.equal(r.segments.find(s => s.lineId === 'a').start, 0.1);
  assert.equal(r.segments.find(s => s.lineId === 'a').status, 'manual');
  assert.equal(r.segments.find(s => s.lineId === 'b').start, 2.04);
  assert.equal((await request(f, base + '/transcript')).json().words[0].start, 0.2);
  assert.deepEqual((await persistence.getRecordingAsset(f.session.id, r.id)).analysis.words, originalWords);
  assert.equal((await request(f, base + '/waveform')).json().from, 0); // ASR-only correction leaves the actual audio clock alone.
  assert.equal(f.reload(JSON.parse(JSON.stringify(f.store()))).recordings[0].timeCalibration.offset, 0.2);
  assert.equal((await request(f, base + '/segments/a/unlock', {method: 'POST'})).status, 200);
  assert.equal(r.segments.find(s => s.lineId === 'a').status, 'review');
  assert.equal((await request(f, base + '/timing', {method: 'PUT', body: {anchors: [{wordId: 999, time: 1}]}})).status, 400);
  const featureRevision = r.revision;
  assert.equal((await request(f, base + '/timing', {method: 'PUT', body: {anchors: [{wordId: 0, time: .2}], applyToFeatures: true}})).status, 202);
  await waitFor(() => r.status === 'ready' && r.revision >= featureRevision + 2);
  assert.equal(r.featureCalibration.offset, .2);
  assert.equal((await request(f, base + '/waveform')).json().from, .2);
  const resetRevision = r.revision;
  await request(f, base + '/timing', {method: 'PUT', body: {anchors: [], applyToFeatures: true}});
  await waitFor(() => r.status === 'ready' && r.revision >= resetRevision + 2);
  assert.equal(r.timeCalibration, null); assert.equal(r.featureCalibration, null);
});

test('local clock metadata rejects mismatched samples and survives a calibrated portable backup', async t => {
  const f = fixture(); t.after(() => f.dispose()); const r = await createLocal(f);
  const base = `/api/session/${f.session.id}/recordings/${r.id}`;
  const words = [{word: '我們今晚開始演出', start: 0, end: 1.44, confidence: .99}];
  const chunk = unpack(localChunk(r, 0, {words}));
  chunk.metadata.clock = {sampleRate: 16000, fromSample: 0, sampleCount: Math.round(r.duration * 16000) + 1};
  assert.equal((await request(f, base + '/local/chunks/0', chunkRequest(pack(chunk.metadata, chunk.features)))).status, 400);
  chunk.metadata.clock.sampleCount--;
  chunk.metadata.clock.providerDuration = r.duration;
  assert.equal((await request(f, base + '/local/chunks/0', chunkRequest(pack(chunk.metadata, chunk.features)))).status, 200);
  await request(f, base + '/local/finish', {method: 'POST'});
  await waitFor(() => f.session.recordings[0].status === 'ready');
  const record = f.session.recordings[0], revision = record.revision;
  const updated = await request(f, base + '/timing', {method: 'PUT', body: {anchors: [{wordId: 0, time: .2}]}});
  assert.equal(updated.status, 202);
  await waitFor(() => record.status === 'ready' && record.revision >= revision + 2);
  const diagnostic = (await request(f, base + '/transcript')).json().diagnostics;
  assert.equal(diagnostic.clockVersion, 1); assert.equal(diagnostic.chunks, 1);
  const backup = (await request(f, base + '/local/export')).bytes;
  await request(f, base, {method: 'DELETE'});
  const restored = await request(f, `/api/session/${f.session.id}/recordings/local/import`, {
    method: 'POST', body: backup, headers: {'content-type': 'application/octet-stream'}});
  assert.equal(restored.status, 201, restored.bytes.toString());
  assert.equal(restored.json().recording.timeCalibration.offset, .2);
  assert.deepEqual(restored.json().recording.timeCalibration.anchors, [{wordId: 0, edge: 'start', time: .2}]);
  const restoredId = restored.json().recording.id;
  assert.equal((await persistence.getRecordingAsset(f.session.id, restoredId)).analysis.clockVersion, 1);
});

test('point-timed words survive local chunk storage, review and portable backup without shifting other cues', async t => {
  const f = fixture(); t.after(() => f.dispose()); const r = await createLocal(f, 6);
  const base = `/api/session/${f.session.id}/recordings/${r.id}`;
  const words = [...'我們今晚開始演出'.split('').map((word, i) => ({word, start: i * .2, end: (i + 1) * .2, confidence: .99})),
    {word: '可是我答應過你', start: 4, end: 5.5, confidence: .99},
    {word: '啊', start: 5.6, end: 5.9, confidence: .99},
    {word: '啊', start: 5.7, end: 5.7, confidence: .99},
    {word: '尾', start: 6, end: 6, confidence: .99}];
  words[2].end = words[2].start;
  const response = await request(f, base + '/local/chunks/0', chunkRequest(localChunk(r, 0, {words})));
  assert.equal(response.status, 200, response.bytes.toString());
  await request(f, base + '/local/finish', {method: 'POST'});
  await waitFor(() => f.session.recordings[0].status === 'ready');
  const record = f.session.recordings[0];
  assert.equal(record.segments.find(s => s.lineId === 'a').status, 'review');
  assert.match(record.segments.find(s => s.lineId === 'a').reviewReason, /時間範圍/);
  assert.equal(record.segments.find(s => s.lineId === 'b').start, 4);
  const transcript = (await request(f, base + '/transcript')).json();
  assert.equal(transcript.words.length, words.length);
  assert.equal(transcript.words[2].timingUncertain, true);
  assert.equal(transcript.words.at(-1).start, 6);
  assert.equal(transcript.diagnostics.uncertainWords, 3);
  assert.equal(transcript.diagnostics.invalidWords, 0);
  const backup = (await request(f, base + '/local/export')).bytes;
  await request(f, base, {method: 'DELETE'});
  const restored = await request(f, `/api/session/${f.session.id}/recordings/local/import`, {
    method: 'POST', body: backup, headers: {'content-type': 'application/octet-stream'}});
  assert.equal(restored.status, 201, restored.bytes.toString());
  const asset = await persistence.getRecordingAsset(f.session.id, restored.json().recording.id);
  assert.equal(asset.analysis.words.length, words.length);
  assert.equal(asset.analysis.words[2].timingUncertain, true);
  assert.equal(asset.analysis.words.at(-1).timingUncertain, true);
});

test('all 12 batches complete despite the reported tail overrun and preserve its recovery through backup', async t => {
  const {chunkClock, analyseChunkWords} = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../../client/src/lib/recording-clock.js')).href);
  const f = fixture(); t.after(() => f.dispose()); const r = await createLocal(f, 3590);
  const base = `/api/session/${f.session.id}/recordings/${r.id}`;
  // This legacy first batch represents progress already saved before updating.
  await request(f, base + '/local/chunks/0', chunkRequest(localChunk(r, 0, {
    words: [{word: '我們今晚開始演出', start: 1, end: 2.44, confidence: .99}]})));
  assert.equal((await request(f, base + '/local/state')).json().completed.length, 1);
  for (let index = 1; index < 12; index++) {
    const start = index * 300, end = Math.min(r.duration, start + 300), clock = chunkClock(r.duration, start, end);
    const raw = index === 1 ? [{word: '可是我答應過你', start: 303.705, end: 305.145, confidence: .99}]
      : index === 2 ? [{word: '可是我答應過你', start: 3.705, end: 5.145, confidence: .99}] : [];
    const result = analyseChunkWords(raw, clock, clock.sampleCount / 16000, {chunkIndex: index, chunkCount: 12});
    if (index === 1) result.wordIssues[0].wordIndex = 604;
    const data = unpack(localChunk(r, index, {words: result.words}));
    Object.assign(data.metadata, {clock, wordIssues: result.wordIssues, wordContextVersion: 1,
      requestId: '01a181fb-1fb6-7271-bf2b-92b55aecdff3'});
    const response = await request(f, base + `/local/chunks/${index}`, chunkRequest(pack(data.metadata, data.features)));
    assert.equal(response.status, 200, response.bytes.toString());
  }
  assert.equal((await request(f, base + '/local/state')).json().completed.length, 12);
  await request(f, base + '/local/finish', {method: 'POST'});
  await waitFor(() => f.session.recordings[0].status === 'ready');
  const record = f.session.recordings[0], segment = record.segments.find(item => item.lineId === 'b');
  assert.equal(segment.start, 601.705); assert.equal(segment.end, 603.145); assert.equal(segment.status, 'auto');
  assert.match(record.timingNotice, /1 個異常詞已由相鄰片段補回；0 個仍待核對/);
  const diagnostic = (await request(f, base + '/transcript')).json().diagnostics;
  assert.equal(diagnostic.wordIssues[0].wordIndex, 604);
  assert.equal(diagnostic.wordIssues[0].start, 303.705); assert.equal(diagnostic.wordIssues[0].end, 305.145);
  assert.equal(diagnostic.wordIssues[0].status, 'recovered'); assert.deepEqual(diagnostic.wordIssues[0].recoveredBy, [2]);
  assert.equal(diagnostic.wordIssues[0].requestId, '01a181fb-1fb6-7271-bf2b-92b55aecdff3');
  const backup = (await request(f, base + '/local/export')).bytes;
  await request(f, base, {method: 'DELETE'});
  const restored = await request(f, `/api/session/${f.session.id}/recordings/local/import`, {
    method: 'POST', body: backup, headers: {'content-type': 'application/octet-stream'}});
  assert.equal(restored.status, 201, restored.bytes.toString());
  const asset = await persistence.getRecordingAsset(f.session.id, restored.json().recording.id);
  assert.equal(asset.analysis.wordIssues[0].status, 'recovered');
  assert.deepEqual(asset.analysis.wordIssues[0].recoveredBy, [2]);
});

test('an unresolved boundary word leaves a review record while the rest of the recording completes', async t => {
  const {chunkClock, analyseChunkWords} = await import(require('node:url').pathToFileURL(path.resolve(__dirname, '../../client/src/lib/recording-clock.js')).href);
  const f = fixture(); t.after(() => f.dispose()); const r = await createLocal(f, 601.44);
  const base = `/api/session/${f.session.id}/recordings/${r.id}`;
  for (let index = 0; index < 3; index++) {
    const clock = chunkClock(r.duration, index * 300, Math.min(r.duration, (index + 1) * 300));
    const raw = index === 1 ? [{word: '缺少的交界台詞', start: 303.3, end: 305, confidence: .99}]
      : index === 2 ? [{word: '可是我答應過你', start: 2, end: 3.44, confidence: .99}] : [];
    const result = analyseChunkWords(raw, clock, clock.sampleCount / 16000);
    const data = unpack(localChunk(r, index, {words: result.words}));
    Object.assign(data.metadata, {clock, wordContextVersion: 1, wordIssues: result.wordIssues});
    const response = await request(f, base + `/local/chunks/${index}`, chunkRequest(pack(data.metadata, data.features)));
    assert.equal(response.status, 200, response.bytes.toString());
  }
  await request(f, base + '/local/finish', {method: 'POST'});
  await waitFor(() => f.session.recordings[0].status === 'ready');
  const record = f.session.recordings[0];
  assert.match(record.timingNotice, /1 個仍待核對/);
  assert.equal(record.segments.find(item => item.lineId === 'b').status, 'review');
  const diagnostic = (await request(f, base + '/transcript')).json().diagnostics;
  assert.equal(diagnostic.wordIssues[0].status, 'review');
  assert.match(diagnostic.issues.join('；'), /尚未由相鄰片段補回/);
});

test('AI recording alignment is authenticated, validates word IDs, caches results and never persists the API key', async t => {
  let aiCalls = 0, deepgramCalls = 0;
  const f = fixture({recordingRequest: async (url, options) => {
    if (url.includes('api.openai.com')) {
      aiCalls++;
      const input = JSON.parse(JSON.parse(options.body).input);
      assert.equal(input.targets.length, 1); assert.equal(input.targets[0].lineId, 'a');
      return {ok: true, json: async () => ({status: 'completed', output_text: JSON.stringify({matches: [{
        lineId: 'a', status: 'matched', startWordId: 0, endWordId: 0, startChar: null, endChar: null, reason: '台詞少一個字，前後文一致',
      }]})})};
    }
    deepgramCalls++;
    return {ok: true, json: async () => ({results: {channels: [{alternatives: [{words: [
      {word: '我們今晚開始演出', start: 0, end: 1.44, confidence: .99},
      {word: '可是我答應過你', start: 1.84, end: 3.28, confidence: .99},
    ]}]}]}})};
  }}); t.after(() => f.dispose());
  const r = await importRecording(f), base = `/api/session/${f.session.id}/recordings/${r.id}`;
  f.session.lines[0].text = '我們今晚就開始演出';
  await request(f, `/api/session/${f.session.id}/recordings`);
  assert.equal((await request(f, base + '/align', {method: 'POST', body: {mode: 'ai'}, cookie: ''})).status, 401);
  for (let i = 0; i < 2; i++) {
    const revision = r.revision;
    const response = await request(f, base + '/align', {method: 'POST', body: {mode: 'ai', apiKey: 'never-store-this-test-key'}});
    assert.equal(response.status, 202, response.bytes.toString());
    await waitFor(() => r.status === 'ready' && r.revision >= revision + 2);
    assert.equal(r.segments.find(s => s.lineId === 'a').source, 'openai');
    assert.equal(r.segments.find(s => s.lineId === 'a').status, 'review');
  }
  assert.equal(aiCalls, 1); assert.equal(deepgramCalls, 1);
  assert.ok(!JSON.stringify(f.store()).includes('never-store-this-test-key'));
  assert.ok(!JSON.stringify((await persistence.getRecordingAsset(f.session.id, r.id)).analysis).includes('never-store-this-test-key'));
});

test('a script edit while AI is running fences the response and cannot overwrite current cues', async t => {
  let resolveAI, started = false;
  const f = fixture({recordingRequest: async url => {
    if (url.includes('api.openai.com')) {
      started = true;
      return new Promise(resolve => {resolveAI = resolve;});
    }
    return {ok: true, json: async () => ({results: {channels: [{alternatives: [{words: [
      {word: '我們今晚開始演出', start: 0, end: 1.44, confidence: .99},
      {word: '可是我答應過你', start: 1.84, end: 3.28, confidence: .99},
    ]}]}]}})};
  }}); t.after(() => f.dispose());
  const r = await importRecording(f), base = `/api/session/${f.session.id}/recordings/${r.id}`;
  f.session.lines[0].text = '我們今晚就開始演出';
  await request(f, `/api/session/${f.session.id}/recordings`);
  await request(f, base + '/align', {method: 'POST', body: {mode: 'ai', apiKey: 'test-placeholder'}});
  await waitFor(() => started);
  f.session.lines[0].text = '這是另一個剛修改的台詞';
  resolveAI({ok: true, json: async () => ({status: 'completed', output_text: JSON.stringify({matches: [{
    lineId: 'a', status: 'matched', startWordId: 0, endWordId: 0, startChar: null, endChar: null, reason: '過期的配對',
  }]})})});
  await waitFor(() => r.status === 'error');
  assert.match(r.error, /劇本已更新/);
  assert.notEqual(r.segments.find(s => s.lineId === 'a').source, 'openai');
  assert.equal(f.session.lines[0].text, '這是另一個剛修改的台詞');
});

test('token failures distinguish upstream credentials, permissions, rate limits and service errors without leaking secrets',async t=>{
  const requestId='12345678-abcd-1234-abcd-123456789abc';
  for(const [status,expected,httpStatus] of [[401,/HTTP 401.*是否有效/,502],[403,/HTTP 403.*Member/,502],
    [429,/HTTP 429.*稍後/,429],[503,/HTTP 503.*稍後/,502],[400,/HTTP 400.*設定/,502]]) {
    await t.test(String(status),async t=>{
      const f=fixture({recordingRequest:async()=>({ok:false,status,json:async()=>({
        err_code:'UPSTREAM_ERROR',err_msg:'test-only-not-a-real-key',request_id:requestId,
      })})});t.after(()=>f.dispose());const r=await createLocal(f);
      const response=await request(f,`/api/session/${f.session.id}/recordings/${r.id}/local/token`,{method:'POST'});
      assert.equal(response.status,httpStatus);assert.match(response.json().error,expected);
      assert.equal(response.json().providerStatus,status);assert.equal(response.json().requestId,requestId);
      assert.equal(response.headers['cache-control'],'no-store');assert.ok(!response.bytes.includes('test-only-not-a-real-key'));
      if(status!==403)assert.ok(!response.json().error.includes('Member'));
      assert.equal((await request(f,`/api/session/${f.session.id}/recordings/${r.id}/local/state`)).json().completed.length,0);
    });
  }
});

test('follow history records real text/manual transitions, exports every visit and enforces authorization', async t => {
  const f = fixture();
  t.after(async () => { await f.history.end(f.session.id); f.dispose(); });
  const root = `/api/session/${f.session.id}/follow-history`;
  assert.equal((await request(f, root, {cookie: ''})).status, 401);
  assert.equal((await request(f, root)).json().runs.length, 0);
  f.socket('setSubtitleControlMode', {sessionId: f.session.id, mode: 'auto'});
  f.transcript('我們今晚開始演出', {streamId: 'recording-live', itemId: 'first', startMs: 0, endMs: 1000, isFinal: true});
  const list = (await request(f, root)).json();
  assert.equal(list.runs.length, 1);
  const id = list.runs[0].id;
  f.socket('setCurrentIndex', {sessionId: f.session.id, index: 2});
  f.transcript('可是我答應過你', {streamId: 'recording-live', itemId: 'second', startMs: 1100, endMs: 2000, isFinal: true});
  const detail = (await request(f, `${root}/${id}`)).json();
  assert.equal(detail.rows[0].visits[0].source, 'initial');
  assert.equal(detail.rows[0].visits[0].confirmations[0]?.source, 'transcript', JSON.stringify(detail.recentEvents));
  assert.equal(detail.rows[2].visits[0].source, 'manual');
  assert.equal(detail.rows[2].visits[0].confirmations[0].source, 'transcript');
  f.socket('setSubtitleControlMode', {sessionId: f.session.id, mode: 'manual'});
  f.socket('setCurrentIndex', {sessionId: f.session.id, index: 2});
  f.socket('setSubtitleControlMode', {sessionId: f.session.id, mode: 'auto'});
  const resumed = (await request(f, `${root}/${id}`)).json();
  assert.equal(resumed.run.endedAt, null);
  assert.equal(resumed.rows[2].visits.length, 2);
  assert.equal(resumed.rows[2].visits[1].source, 'manual');
  const csv = await request(f, `${root}/${id}?format=csv`);
  assert.equal(csv.status, 200); assert.match(csv.headers['content-type'], /text\/csv/);
  assert.equal(csv.headers['cache-control'], 'no-store'); assert.match(csv.bytes.toString(), /人工操作/);
  const json = await request(f, `${root}/${id}?format=json`);
  assert.equal(json.status, 200); assert.ok(json.json().events.some(event => event.type === 'cue_confirm'));
  assert.equal((await request(f, `${root}/${id}?format=html`)).status, 400);
  assert.equal((await request(f, `${root}/${id}`, {method: 'DELETE'})).status, 409);
  const originalOwner = f.session.ownerUserId;
  f.session.ownerUserId = 'another-user';
  assert.equal((await request(f, root)).status, 404);
  assert.equal((await request(f, `${root}/${id}?format=json`)).status, 404);
  f.session.ownerUserId = originalOwner;
  assert.equal((await request(f, `${root}/${id}/end`, {method: 'POST'})).status, 200);
  const next = (await request(f, `${root}/start`, {method: 'POST'})).json().id;
  assert.notEqual(next, id);
  assert.equal((await request(f, root)).json().runs.length, 2);
  assert.equal((await request(f, `${root}/${id}`, {method: 'DELETE'})).status, 200);
  assert.equal((await request(f, `${root}/${id}`)).status, 404);
});

test('token transport failures and malformed responses remain actionable and never expose raw provider errors',async t=>{
  for(const [name,transport,expected,status] of [
    ['timeout',async()=>{throw Object.assign(new Error('test-only-not-a-real-key'),{name:'TimeoutError'});},/逾時/,504],
    ['network',async()=>{throw new Error('test-only-not-a-real-key');},/網路/,502],
    ['malformed',async()=>({ok:true,json:async()=>{throw new Error('invalid response');}}),/未回傳有效/,502],
    ['non-json denial',async()=>({ok:false,status:403,json:async()=>{throw new Error('invalid response');}}),/HTTP 403.*Member/,502],
  ]) {
    await t.test(name,async t=>{
      const f=fixture({recordingRequest:transport});t.after(()=>f.dispose());const r=await createLocal(f);
      const reply=await request(f,`/api/session/${f.session.id}/recordings/${r.id}/local/token`,{method:'POST'});
      assert.equal(reply.status,status);assert.match(reply.json().error,expected);
      assert.ok(!reply.bytes.includes('test-only-not-a-real-key'));assert.equal(reply.headers['cache-control'],'no-store');
    });
  }
});
