const {test} = require('node:test');
const assert = require('node:assert/strict');
const {resolveFollowingLanguage, getFollowingLines, describeFollowingScript, isRecordingCompatible} = require('../src/performance-language');
const {hashText, refreshMappings} = require('../src/recordings');

function bilingual() {
  return {transcriptionLanguage: 'en', selectedCellId: 'scene',
    languages: [{id:'primary',name:'中文',code:'zh-TW'}, {id:'english',name:'English',code:'en'}],
    lines: [{id:'a',type:'dialogue',text:'我們今晚開始演出',translations:{english:'We begin the show tonight'}},
      {id:'stage',type:'direction',text:'（離場）'},
      {id:'b',type:'dialogue',text:'可是我答應過你',translations:{english:'But I promised you'}}]};
}

test('performance language selects the matching code/name and explicit bindings support unnamed columns', () => {
  const session=bilingual();
  assert.equal(resolveFollowingLanguage(session).languageId,'english');
  session.languages[1].code='lang-2';assert.equal(resolveFollowingLanguage(session).languageId,'english');
  session.languages[1].name='第二語言';assert.equal(resolveFollowingLanguage(session).languageId,null);
  session.followingLanguageIds={en:'english'};
  assert.equal(resolveFollowingLanguage(session).languageId,'english');
  assert.equal(resolveFollowingLanguage(session).explicit,true);
  assert.equal(resolveFollowingLanguage({transcriptionLanguage:'zh-TW'}).languageId,'primary');
});

test('following projection preserves cue positions and Chinese display text while matching English', () => {
  const session=bilingual(), projected=getFollowingLines(session);
  assert.deepEqual(projected.map(line=>line.id),['a','stage','b']);
  assert.equal(projected[0].text,'We begin the show tonight');assert.equal(projected[1].type,'direction');
  assert.equal(session.lines[0].text,'我們今晚開始演出');
  session.lines=structuredClone(session.lines);
  assert.equal(getFollowingLines(session),projected);
  session.lines[0].text='中文譯文修改';assert.equal(getFollowingLines(session),projected);
  session.lines[0].translations.english='English script changed';
  assert.notEqual(getFollowingLines(session),projected);assert.equal(getFollowingLines(session)[0].text,'English script changed');
});

test('missing/deleted English columns and blank English cues never silently fall back to Chinese', () => {
  const session=bilingual();session.lines[2].translations.english='';
  assert.equal(getFollowingLines(session)[2].text,'');
  const info=describeFollowingScript(session);assert.equal(info.missingCount,1);assert.deepEqual(info.missingIndices,[2]);
  session.followingLanguageIds={en:'deleted-column'};
  assert.equal(resolveFollowingLanguage(session).languageId,null);
  assert.equal(describeFollowingScript(session).available,false);
  assert.equal(getFollowingLines(session)[0].text,'');
});

test('reference audio must match both performance language and selected script column', () => {
  const session=bilingual(), recording={language:'en',scriptLanguageId:'english'};
  assert.equal(isRecordingCompatible(session,recording),true);
  assert.equal(isRecordingCompatible(session,{...recording,language:'zh-TW'}),false);
  assert.equal(isRecordingCompatible(session,{...recording,scriptLanguageId:'primary'}),false);
});

test('English recordings invalidate on English edits while Chinese translation edits retain their calibration', () => {
  const session=bilingual();
  const english=getFollowingLines(session), chinese=getFollowingLines(session,'zh-TW');
  const profile=(id,language,scriptLanguageId,lines)=>({id,language,scriptLanguageId,cellId:'scene',revision:1,
    segments:lines.filter(line=>line.type!=='direction').map(line=>({lineId:line.id,textHash:hashText(line),start:0,end:1,status:'auto'}))});
  session.recordings=[profile('en','en','english',english),profile('zh','zh-TW','primary',chinese)];
  session.lines[0].text='中文修改';refreshMappings(session);
  assert.equal(session.recordings[0].segments[0].status,'auto');assert.equal(session.recordings[1].segments[0].status,'stale');
  session.lines[0].translations.english='English change';refreshMappings(session);
  assert.equal(session.recordings[0].segments[0].status,'stale');
  session.lines[0].translations.english=english[0].text;refreshMappings(session);
  assert.equal(session.recordings[0].segments[0].status,'auto');
});
