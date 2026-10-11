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

function fixture() {
  const filename = require.resolve('../src/server');
  let source = fs.readFileSync(filename,'utf8');
  source = source.replace('  broadcast: broadcastControlState,', `  broadcast: broadcastControlState,
    request: async () => ({ok: true, json: async () => ({results: {channels: [{alternatives: [{words: [
      {word:'我們今晚開始演出',start:0,end:1.44,confidence:0.99},
      {word:'可是我答應過你',start:1.84,end:3.28,confidence:0.99},
    ]}]}]}})}),`);
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
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
      return {app,session,stream,cookie:AUTH_COOKIE_NAME+'='+cookieToken, runtime:referenceRuntime,
        state:()=>getPublicAutoFollowState(session), viewer:()=>getViewerPayload(session),
        transcript:(text,options)=>handleAutoFollowTranscript(session.id,text,options),
        audioResult: result=>handleReferenceAudioResult(session.id,result),
        store:()=>serializeSessionForStorage(session), reload:s=>ensureSessionStructure(s),
        send(payload) {let reply;handlers.get('transcription:audio')({sessionId:session.id,...payload},value=>{reply=value});return reply;},
        dispose(){referenceRuntime.dispose();recordingRoutes.cancelSession(session.id);for(const timer of currentIndexPersistTimers.values())clearTimeout(timer);for(const timer of latestRoomStateKeyframes.values())clearTimeout(timer);}
      };
    };
  `),filename);
  return loaded.exports();
}

// Exercise the real Express auth, multipart parser and routes with Node HTTP
// objects, without listening on a port or contacting a transcription provider.
async function request(f, route, {method='GET', body, cookie=f.cookie, headers={}}={}) {
  let bytes=Buffer.alloc(0);
  if(body instanceof FormData) {
    const encoded=new Request('http://test.invalid/',{method:'POST',body});
    bytes=Buffer.from(await encoded.arrayBuffer());headers['content-type']=encoded.headers.get('content-type');
  } else if(body) {bytes=Buffer.from(JSON.stringify(body));headers['content-type']='application/json';}
  const req=Readable.from(bytes.length?[bytes]:[]);Object.assign(req,{method,url:route,originalUrl:route,headers:{...headers,cookie,'content-length':String(bytes.length)},httpVersion:'1.0',httpVersionMajor:1,httpVersionMinor:0});
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
  await f.runtime.ensure(f.session);await waitFor(()=>f.runtime.sessions.get(f.session.id)?.ready);
  const take=Buffer.concat([phrasePcm(phrases[0],24000,{speed:0.85,amplitude:0.1,pitch:1.01,silence:.4}),phrasePcm(phrases[1],24000,{speed:0.85,amplitude:0.1,pitch:1.01})]);
  let sequence=0;
  for(let offset=0;offset+960<=take.length;offset+=960){
    assert.equal(f.send({audio:take.subarray(offset,offset+960).toString('base64'),durationMs:20,level:.04,sequence:++sequence}).ok,true);
    await new Promise(resolve=>setTimeout(resolve,3));
  }
  await waitFor(()=>f.session.currentIndex===2);
  assert.equal(f.state().lastDecision.source,'audio');assert.equal(f.viewer().text,'可是我答應過你');
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
    assert.equal(r.error,'');assert.equal(r.segments.find(s=>s.lineId==='a').status,'auto');
  }finally{process.env.DEEPGRAM_API_KEY=key;}
  const original=f.session.lines[0].text;
  f.session.lines[0].text='修改台詞';
  await request(f,`/api/session/${f.session.id}/recordings`);
  assert.equal(r.segments.find(s=>s.lineId==='a').status,'stale');
  f.session.lines[0].text=original;
  await request(f,`/api/session/${f.session.id}/recordings`);
  assert.equal(r.segments.find(s=>s.lineId==='a').status,'auto');
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
