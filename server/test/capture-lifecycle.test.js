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
  const calls={backendStops:0,listenerCount:0},statuses=[],contexts=[];
  const events={addEventListener(){calls.listenerCount++;},removeEventListener(){calls.listenerCount--;}};
  class AudioContext {
    constructor(){this.state='running';this.closes=0;this.sampleRate=48000;contexts.push(this);}
    resume(){return waitResume?new Promise(resolve=>{allowResume=resolve}):Promise.resolve();}
    close(){this.closes++;return Promise.resolve();}
    createMediaStreamSource(){return node();}createGain(){return node();}createScriptProcessor(){return node();}
    addEventListener(){calls.listenerCount++;}removeEventListener(){calls.listenerCount--;}
  }
  const socket={connected:true,timeout(){return this;},emit(name,_payload,reply){
    if(name==='transcription:start')replyProvider=reply;
    if(name==='transcription:stop')calls.backendStops++;
  }};
  const context=vm.createContext({
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
  vm.runInContext(source.slice(start,end)+'\nglobalThis.begin=handleStartLiveTranscription;',context);
  return {begin:()=>context.begin({autoFollow:true}),attempts,capture,track,contexts,calls,statuses,
    allowPermission:()=>allowPermission(),allowResume:()=>allowResume(),replyProvider:value=>replyProvider(value)};
}

test('a canceled microphone permission request stops only its own late stream',async()=>{
  const f=fixture({waitPermission:true}),pending=f.begin();
  f.attempts.current++;const newer={audioContext:{newer:true}};f.capture.current=newer;
  f.allowPermission();assert.equal(await pending,false);assert.equal(f.track.stops,1);
  assert.equal(f.capture.current,newer);assert.equal(f.calls.backendStops,0);
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
