const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source=fs.readFileSync(require.resolve('../../client/src/pages/ControlPage.jsx'),'utf8');
const start=source.indexOf('  const handleStartLiveTranscription = async');
const end=source.indexOf('  const changeCaptionMode =',start);

function fixture({waitPermission=false,waitResume=false}={}) {
  let allowPermission,allowResume,replyProvider;
  const track={stops:0,readyState:'live',stop(){this.stops++;this.readyState='ended';}};
  const media={getTracks:()=>[track],getAudioTracks:()=>[track]};
  const attempts={current:0},capture={current:{}},node=()=>({connect(){},disconnect(){},gain:{value:0}});
  const calls={backendStops:0,listenerCount:0,audio:[],reconnects:0,transportCloses:0},statuses=[],contexts=[];
  const events={addEventListener(){calls.listenerCount++;},removeEventListener(){calls.listenerCount--;}};
  class AudioContext {
    constructor(){this.state='running';this.closes=0;this.sampleRate=48000;this.currentTime=0;contexts.push(this);}
    resume(){return waitResume?new Promise(resolve=>{allowResume=resolve}):Promise.resolve();}
    close(){this.closes++;return Promise.resolve();}
    createMediaStreamSource(){return node();}createGain(){return node();}createScriptProcessor(){return node();}
    addEventListener(){calls.listenerCount++;}removeEventListener(){calls.listenerCount--;}
  }
  const listeners=new Map();
  const socket={connected:true,io:{engine:{writeBuffer:[],transport:{name:'websocket',ws:{bufferedAmount:0},close(){calls.transportCloses++;}}}},
    on(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    off(name,fn){listeners.get(name)?.delete(fn);},
    disconnect(){this.connected=false;},connect(){calls.reconnects++;this.connected=true;for(const fn of listeners.get('connect')||[])fn();},
    timeout(){return this;},emit(name,_payload,reply){
    if(name==='transcription:start')replyProvider=reply;
    if(name==='transcription:stop')calls.backendStops++;
    if(name==='transcription:audio')calls.audio.push(_payload);
  }};
  const context=vm.createContext({
    performance, setTimeout, clearTimeout,
    useEffect(){},captureStartRef:{},MIC_DIAGNOSTIC_UPDATE_MS:500,TARGET_SAMPLE_RATE:24000,
    mixChannelsToMono:channels=>channels[0],downsampleFloat32:s=>s,float32ToInt16:s=>s,
    int16ToBase64:()=> 'AA==',signalMetrics:()=>({level:.1,peak:.2,samples:480,clippedSamples:0}),setMicDiagnostics(){},
    window:{...events,AudioContext},document:{...events,visibilityState:'visible'},
    navigator:{mediaDevices:{getUserMedia:()=>waitPermission?new Promise(resolve=>{allowPermission=()=>resolve(media)}):Promise.resolve(media)}},
    sessionId:'test',socketRef:{current:socket},captureStateRef:capture,transcriptionAttemptRef:attempts,
    transcription:{provider:'deepgram',status:'idle',active:false,language:'zh-TW'},apiKey:'',
    persistTranscriptionContext:async()=>true,setStatus:value=>statuses.push(value),setTranscription(){},
    releaseMicrophoneCapture:()=>{attempts.current++;capture.current={};},
    autoStartedTranscriptionRef:{current:false},projectorStartedTranscriptionRef:{current:false},
    micDiagnosticsUpdateRef:{current:0},DEFAULT_TRANSCRIPTION_PROVIDER:'deepgram',DEFAULT_TRANSCRIPTION_MODEL:'test',
    APP_BUILD:{commit:'capture-test',builtAt:null},
  });
  vm.runInContext(fs.readFileSync(require.resolve('../../client/src/lib/capture-recovery.js'),'utf8').replace(/export /g,'')+
    '\nglobalThis.captureRecovery = new CaptureRecovery();',context);
  vm.runInContext(fs.readFileSync(require.resolve('../../client/src/lib/capture-transport.js'),'utf8').replace(/export /g,''),context);
  vm.runInContext(source.slice(start,end)+'\nglobalThis.begin=handleStartLiveTranscription;',context);
  return {begin:options=>context.begin({autoFollow:true,...options}),attempts,capture,track,contexts,calls,statuses,recovery:context.captureRecovery,
    allowPermission:()=>allowPermission(),allowResume:()=>allowResume(),replyProvider:value=>replyProvider(null,value)};
}

test('a canceled microphone permission request stops only its own late stream',async()=>{
  const f=fixture({waitPermission:true}),pending=f.begin();
  f.attempts.current++;const newer={audioContext:{newer:true}};f.capture.current=newer;
  f.allowPermission();assert.equal(await pending,false);assert.equal(f.track.stops,1);
  assert.equal(f.capture.current,newer);assert.equal(f.calls.backendStops,0);
});

test('the actual capture callback discards delayed audio-thread samples and asks for one recovery', async()=>{
  const f=fixture(),pending=f.begin();await new Promise(resolve=>setImmediate(resolve));
  f.replyProvider({ok:true});assert.equal(await pending,true,JSON.stringify(f.statuses));
  f.contexts[0].currentTime=4;
  f.capture.current.captureNode.onaudioprocess({playbackTime:2,inputBuffer:{numberOfChannels:1,getChannelData:()=>new Float32Array(480)}});
  assert.equal(f.calls.audio.length,0);assert.equal(f.recovery.pending,true);
  assert.equal(f.recovery.reason,'capture_backlog');
});

test('the actual start never flushes its connection backlog into the new provider clock',async()=>{
  const f=fixture(),pending=f.begin();await new Promise(resolve=>setImmediate(resolve));
  const emit=()=>f.capture.current.captureNode.onaudioprocess({playbackTime:f.contexts[0].currentTime,
    inputBuffer:{numberOfChannels:1,getChannelData:()=>new Float32Array(480)}});
  emit();assert.equal(f.calls.audio.length,0);
  f.replyProvider({ok:true});assert.equal(await pending,true,JSON.stringify(f.statuses));assert.equal(f.calls.audio.length,0);
  emit();assert.equal(f.calls.audio.length,1);assert.ok(f.calls.audio[0].captureId);
});
test('a matching running snapshot can acknowledge capture readiness before the start ACK arrives',async()=>{
  const f=fixture(),pending=f.begin();await new Promise(resolve=>setImmediate(resolve));
  f.capture.current.confirmReady();assert.equal(await pending,true);
  assert.equal(f.capture.current.starting,false);
  f.replyProvider({ok:true});assert.equal(f.recovery.desired,true);
});

test('a transmission recovery resets the real capture connection before requesting a new provider stream',async()=>{
  const f=fixture();f.recovery.arm({autoFollow:true});
  const pending=f.begin({recovering:true,recovery:{reason:'capture_transport_backlog',attempt:1}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.reconnects,1);assert.equal(f.calls.transportCloses,1);
  f.replyProvider({ok:true});assert.equal(await pending,true);
  assert.ok(f.capture.current.audioTransport);
});

test('a canceled audio setup closes its context without changing the newer capture',async()=>{
  const f=fixture({waitResume:true}),pending=f.begin();await new Promise(resolve=>setImmediate(resolve));
  f.attempts.current++;const newer={audioContext:{newer:true}};f.capture.current=newer;f.allowResume();
  assert.equal(await pending,false);assert.equal(f.contexts[0].closes,1);assert.equal(f.track.stops,1);
  assert.equal(f.capture.current,newer);assert.equal(f.calls.backendStops,0);
});

test('a late failed ASR start cannot release or stop a newer capture after a caption-mode switch',async()=>{
  const f=fixture(),pending=f.begin();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(f.calls.listenerCount>0);
  f.attempts.current++;const newer={audioContext:{newer:true}};f.capture.current=newer;
  f.replyProvider({ok:false,reason:'old start canceled'});assert.equal(await pending,false);
  assert.equal(f.capture.current,newer);assert.equal(f.calls.backendStops,0);assert.equal(f.calls.listenerCount,0);
  assert.equal(f.track.stops,1);assert.equal(f.contexts[0].closes,1);
  assert.equal(f.statuses.some(status=>status.kind==='error'),false);
});
