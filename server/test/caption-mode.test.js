const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const {enterLiveCaptions, resumeScriptCaptions} = require('../src/caption-mode');

function fixture() {
  const filename=require.resolve('../src/server');
  const loaded=new Module(filename,module);loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(fs.readFileSync(filename,'utf8').replace(/startServer\(\);\s*$/, `
    module.exports=()=>{
      const user={id:'caption-owner',role:USER_ROLES.OPERATOR};users.set(user.id,user);
      const token='caption-test-token';authSessions.set(hashToken(token),{userId:user.id,expiresAt:Date.now()+60000});
      const session=createSessionRecord(user.id);session.cells[0].lines=[createLineRecord({id:'a',text:'第一句'}),createLineRecord({id:'b',text:'第二句',music:true})];
      syncSelectedCellLines(session);session.currentIndex=1;session.subtitleControlMode='auto';session.transcriptionLanguage='en';sessions.set(session.id,session);
      session.languages.push({id:'english',name:'English',code:'en'});session.followingLanguageIds={en:'english'};
      session.recordings=[{id:'r',cellId:session.selectedCellId,status:'ready',language:'en',scriptLanguageId:'english',segments:[]}];session.activeRecordingId='r';
      const events=[];io.to=()=>({emit:(name,payload)=>events.push({name,payload})});persistSession=()=>{};persistApplicationStore=async()=>{};
      const handlers=new Map();io.listeners('connection')[0]({id:'caption-socket',data:{},handshake:{headers:{cookie:AUTH_COOKIE_NAME+'='+token}},on:(name,fn)=>handlers.set(name,fn),emit(){}});
      return {session,events,
        socket(name,payload={}){let reply;handlers.get(name)({sessionId:session.id,...payload},value=>reply=value);return reply;},
        displays:()=>[getViewerPayload(session),getProjectorPayload(session)],
        storage:()=>serializeSessionForStorage(session),
        startStream(socketId='caption-socket'){
          const stream={provider:'deepgram',socketId,ready:true,closing:false,liveTranslationStreamId:'caption-stream',pendingAudioChunks:[],completedFragments:[],
            finalizedLines:[],fragmentByItemId:new Map(),mergedLineOverrides:new Map(),draftByItemId:new Map(),draftSpeakerByItemId:new Map(),draftTranslationsByItemId:new Map(),
            socket:{readyState:1,send(){},close(){this.readyState=3}}};transcriptionStreams.set(session.id,stream);
          updateTranscriptionState(session.id,{active:true,status:'running',text:'上一段演出辨識文字'});return stream;
        },
        liveText(text){updateTranscriptionState(session.id,{text,active:true,status:'running'});},
        patches(stream){broadcastLiveTranscriptionState(session.id,stream);},
        dispose(){referenceRuntime.dispose();for(const timer of latestRoomStateKeyframes.values())clearTimeout(timer.timer||timer);for(const timer of currentIndexPersistTimers.values())clearTimeout(timer);}
      };
    };
  `),filename);return loaded.exports();
}

test('entering discussion blanks both outputs, stops old audio, and preserves the script cue, language, recording and links',t=>{
  const f=fixture();t.after(()=>f.dispose());const before=f.storage(),stream=f.startStream();
  const result=f.socket('caption:set-mode',{mode:'live',language:'zh-TW'});
  assert.equal(result.ok,true);assert.equal(stream.closing,true);assert.equal(f.session.captionMode,'live');assert.equal(f.session.activeRecordingId,null);
  assert.equal(f.session.transcriptionLanguage,'zh-TW');assert.equal(f.session.scriptResume.language,'en');assert.equal(f.session.currentIndex,1);
  f.socket('setCurrentIndex',{index:0});assert.equal(f.session.currentIndex,1);
  for(const output of f.displays()){assert.equal(output.source,'transcription');assert.equal(output.text,'');assert.equal(output.musicActive,false);}
  const stored=f.storage();assert.equal(stored.scriptResume.lineId,'b');assert.equal(stored.viewerToken,before.viewerToken);assert.equal(stored.projectorToken,before.projectorToken);
  f.liveText('座談的新內容');for(const output of f.displays())assert.equal(output.text,'座談的新內容');
  assert.equal(f.socket('caption:set-mode',{mode:'script'}).ok,true);
  assert.equal(f.session.captionMode,'script');assert.equal(f.session.currentIndex,1);assert.equal(f.session.subtitleControlMode,'auto');
  assert.equal(f.session.transcriptionLanguage,'en');assert.equal(f.session.activeRecordingId,'r');
  for(const output of f.displays()){assert.equal(output.source,'script');assert.equal(output.text,'第二句');}
});

test('pausing discussion preserves live text and an ASR failure cannot reveal the previous script',t=>{
  const f=fixture();t.after(()=>f.dispose());f.socket('caption:set-mode',{mode:'live'});f.startStream();f.liveText('請問導演');
  f.socket('transcription:stop',{preserveText:true});
  for(const output of f.displays()){assert.equal(output.source,'transcription');assert.equal(output.text,'請問導演');}
  f.session.transcription.text='';f.session.transcription.status='error';
  for(const output of f.displays()){assert.equal(output.source,'transcription');assert.equal(output.text,'');}
});

test('background recognition in manual script mode does not replace script output',t=>{
  const f=fixture();t.after(()=>f.dispose());f.session.subtitleControlMode='manual';f.session.captionMode='script';const stream=f.startStream();
  for(const output of f.displays()){assert.equal(output.source,'script');assert.equal(output.text,'第二句');}
  f.patches(stream);assert.equal(f.events.some(event=>event.name==='viewer:live-update'||event.name==='projector:live-update'),false);
});

test('another controller cannot stop the current microphone by changing caption mode',t=>{
  const f=fixture();t.after(()=>f.dispose());const stream=f.startStream('other-socket');
  assert.equal(f.socket('caption:set-mode',{mode:'live'}).ok,false);assert.equal(f.session.captionMode,'script');assert.equal(stream.closing,false);
  f.session.captionMode='live';f.session.projectorDisplayMode='transcription';
  f.socket('setSubtitleControlMode',{mode:'auto'});assert.equal(f.session.captionMode,'live');assert.equal(stream.closing,false);
  f.socket('setProjectorDisplayMode',{displayMode:'script'});assert.equal(f.session.projectorDisplayMode,'transcription');assert.equal(stream.closing,false);
});

test('returning from discussion finds the saved cue by ID after edits and skips incompatible audio',()=>{
  const session={captionMode:'script',selectedCellId:'scene',cells:[{id:'scene'}],currentIndex:1,subtitleControlMode:'auto',transcriptionLanguage:'en',
    languages:[{id:'primary',code:'en'}],lines:[{id:'a'},{id:'b'}],recordings:[],activeRecordingId:null};
  enterLiveCaptions(session,'zh-TW');session.lines.unshift({id:'new'});resumeScriptCaptions(session);
  assert.equal(session.currentIndex,2);assert.equal(session.transcriptionLanguage,'en');assert.equal(session.captionMode,'script');
});
