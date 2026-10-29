const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const {Readable, Duplex} = require('node:stream');
process.env.DATABASE_URL = '';
process.env.SUBTITLE_MACHINE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-public-test-'));
process.env.DEEPGRAM_API_KEY = '';
process.env.OPENAI_API_KEY = '';

// Real server payloads, HTTP authorization and socket handlers; no startup,
// operator store, listening port, recording processing or provider calls.
function fixture() {
  const filename = require.resolve('../src/server');
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(filename, 'utf8').replace(/startServer\(\);\s*$/, `
    module.exports = () => {
      const session = createSessionRecord('public-display-owner');
      session.cells[0].lines = Array.from({length:1000}, (_,i) => createLineRecord({id:'cue-'+i,text:'台詞'+i,
        role:'說書人', music:i===5, musicText:'演奏開始', type:i===4?'direction':'dialogue', translations:{en:'Line '+i}}));
      session.languages.push({id:'en',name:'English',code:'en'});
      syncSelectedCellLines(session); sessions.set(session.id,session);
      ensureSessionStructure(session);
      session.currentIndex=5;
      const other = createCellDefinition({id:'second-scene',lines:session.lines},1); session.cells.push(other);
      persistSession=()=>{};scheduleViewerDemandBroadcast=()=>{};
      const broadcasts=[], acknowledgements=[];
      emitLatestRoomState=(room,event,payload)=>broadcasts.push({room,event,payload});
      handleAutoFollowDisplayAck=(...args)=>acknowledgements.push(args);
      function connect(id='public-socket') {
        const handlers=new Map(), events=[];
        const socket={id,data:{},handshake:{headers:{}},on:(name,handler)=>handlers.set(name,handler),emit:(name,payload)=>events.push({name,payload}),
          join(room){let members=io.sockets.adapter.rooms.get(room);if(!members)io.sockets.adapter.rooms.set(room,members=new Set());members.add(id);},
          leave(room){io.sockets.adapter.rooms.get(room)?.delete(id);}};
        io.sockets.sockets.set(id,socket);io.listeners('connection')[0](socket);
        return {socket,events,send:(name,payload)=>handlers.get(name)(payload)};
      }
      return {app,session,other,connect,broadcasts,acknowledgements,
        payload:(cellId,options)=>getViewerPayload(session,cellId,options),
        broadcast:()=>broadcastViewerState(session.id),
        live:stream=>{transcriptionStreams.set(session.id,stream);return broadcastLiveTranscriptionState(session.id,stream);},
        dispose(){referenceRuntime.dispose();for(const timer of latestRoomStateKeyframes.values())clearTimeout(timer);}};
    };
  `),filename);
  return loaded.exports();
}
async function request(app,route) {
  const req=Readable.from([]);
  Object.assign(req,{method:'GET',url:route,originalUrl:route,headers:{},httpVersion:'1.0',httpVersionMajor:1,httpVersionMinor:0});
  const chunks=[],socket=new Duplex({read(){},write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done();}});
  socket.remoteAddress='127.0.0.1';req.socket=socket;req.connection=socket;
  const res=new http.ServerResponse(req);res.assignSocket(socket);
  const done=new Promise((resolve,reject)=>{res.on('finish',resolve);res.on('error',reject);});
  app.handle(req,res);await done;
  const bytes=Buffer.concat(chunks);return {status:res.statusCode,payload:JSON.parse(bytes.subarray(bytes.indexOf('\r\n\r\n')+4).toString())};
}

test('public HTTP prompter uses the scene token, exposes bounded context and shares music with viewer',async t=>{
  const f=fixture();t.after(()=>f.dispose());
  const route='/api/viewer/'+f.session.cells[0].viewerToken;
  const viewer=await request(f.app,route),prompter=await request(f.app,route+'?followOnly=1&includeLines=1');
  assert.equal(prompter.status,200);assert.equal(viewer.status,200);
  assert.equal(viewer.payload.lines,undefined);assert.equal(viewer.payload.cueWindow,undefined);
  assert.equal(prompter.payload.lines,undefined);assert.equal(prompter.payload.currentIndex,5);
  assert.deepEqual(prompter.payload.cueWindow.lines.map(l=>l.id),['cue-3','cue-4','cue-5','cue-6','cue-7','cue-8','cue-9','cue-10','cue-11']);
  assert.equal(prompter.payload.line.id,viewer.payload.line.id);
  assert.equal(prompter.payload.musicActive,true);assert.equal(prompter.payload.musicText,'演奏開始');
  assert.equal(prompter.payload.musicActive,viewer.payload.musicActive);
  assert.equal(prompter.payload.cueWindow.lines[1].type,'direction');
  assert.equal(f.payload(null,{followOnly:true}).lines,undefined);
  assert.equal((await request(f.app,route+'?includeLines=1')).payload.lines.length,1000);
  assert.equal((await request(f.app,'/api/session/'+f.session.id)).status,401);
});

test('hidden, inactive and live states expose no nearby script; edges of the script are bounded',t=>{
  const f=fixture();t.after(()=>f.dispose());
  const options={followOnly:true};
  const waiting=f.payload(f.other.id,options);assert.equal(waiting.source,'waiting');assert.equal(waiting.line,null);assert.equal(waiting.cueWindow,undefined);assert.equal(waiting.lines,undefined);
  f.session.displayEnabled=false;
  const hidden=f.payload(null,options);assert.equal(hidden.musicActive,false);assert.equal(hidden.cueWindow,undefined);assert.equal(hidden.line,null);
  f.session.displayEnabled=true;f.session.captionMode='live';
  const live=f.payload(null,options);assert.equal(live.source,'transcription');assert.equal(live.cueWindow,undefined);assert.equal(live.musicActive,false);
  f.session.captionMode='script';f.session.musicEffectEnabled=false;assert.equal(f.payload(null,options).musicActive,false);
  f.session.currentIndex=0;assert.deepEqual(f.payload(null,options).cueWindow.lines.map(l=>l.id),['cue-0','cue-1','cue-2','cue-3','cue-4','cue-5','cue-6']);
  f.session.currentIndex=999;assert.deepEqual(f.payload(null,options).cueWindow.lines.map(l=>l.id),['cue-997','cue-998','cue-999']);
});

test('the same public socket switches rooms and roles without controlling the cue; broadcasts follow the selected mode',t=>{
  const f=fixture();t.after(()=>f.dispose());const client=f.connect();
  const join=role=>client.send('join',{role,viewerToken:f.session.cells[0].viewerToken,followOnly:true});
  join('viewer');const viewerRoom=client.socket.data.viewerRoom;
  assert.equal(client.events.at(-1).name,'viewer:update');assert.equal(client.events.at(-1).payload.cueWindow,undefined);
  join('prompter');const prompterRoom=client.socket.data.viewerRoom;
  assert.notEqual(prompterRoom,viewerRoom);assert.match(prompterRoom,/^prompter-follow:/);
  assert.equal(client.socket.data.publicRole,'prompter');assert.equal(client.events.at(-1).payload.lines,undefined);
  assert.equal(client.events.at(-1).payload.cueWindow.currentIndex,5);
  client.send('auto-follow:displayed',{decisionId:'test-cue'});
  assert.deepEqual(f.acknowledgements.at(-1),[f.session.id,'prompter','test-cue',f.session.cells[0].id]);
  f.session.currentIndex=6;f.broadcast();
  assert.equal(f.broadcasts.some(b=>b.room===viewerRoom),false);
  assert.equal(f.broadcasts.find(b=>b.room===prompterRoom).payload.cueWindow.currentIndex,6);
  client.send('viewer:live-language',{languageCode:'en'});
  assert.equal(client.events.at(-1).name,'prompter:update');assert.equal(client.events.at(-1).payload.lines,undefined);
  assert.equal(client.socket.data.liveTranslationLanguage,'en');
  join('viewer');assert.equal(client.socket.data.liveTranslationLanguage,'source');
  assert.equal(client.socket.data.viewerRoom,viewerRoom);assert.equal(f.session.currentIndex,6);
  client.send('join',{role:'control',sessionId:f.session.id});
  assert.equal(client.events.at(-1).name,'transcription:error');
  assert.equal(client.socket.data.publicRole,'viewer');
});

test('legacy prompter subscriptions still receive full lines while new ones receive bounded updates and live patches',t=>{
  const f=fixture();t.after(()=>f.dispose());const legacy=f.connect('old'),modern=f.connect('new');
  legacy.send('join',{role:'prompter',viewerToken:f.session.cells[0].viewerToken});
  modern.send('join',{role:'prompter',viewerToken:f.session.cells[0].viewerToken,followOnly:true});
  assert.equal(legacy.events.at(-1).payload.lines.length,1000);assert.equal(modern.events.at(-1).payload.lines,undefined);
  f.broadcast();
  assert.equal(f.broadcasts.find(b=>b.room===legacy.socket.data.viewerRoom).payload.lines.length,1000);
  assert.equal(f.broadcasts.find(b=>b.room===modern.socket.data.viewerRoom).payload.cueWindow.lines.length,9);
  f.session.captionMode='live';
  f.live({liveTranslationStreamId:'test-live',liveTranscriptionRevision:1,language:'zh-TW',completedFragments:[],draftByItemId:new Map(),mergedLineOverrides:new Map()});
  assert.ok(f.broadcasts.some(b=>b.room===modern.socket.data.viewerRoom&&b.event==='prompter:live-update'));
});
