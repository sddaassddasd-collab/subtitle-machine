const assert = require('node:assert/strict');
const { test } = require('node:test');
const { alignFullScript, validatePlan, validateAudit, buildRequest, requestJson, splitCompleteScenes,
  createReview, normalizeAlignmentReviews } = require('../src/full-script-alignment');
const fixture = require('./helpers/alignment-server-fixture');

const cues = [
  { id: 'cause', text: '因為我答應過你，', type: 'dialogue', role: '甲' },
  { id: 'result', text: '所以我一定會回來。', type: 'dialogue', role: '甲' },
  { id: 'stage', text: '（燈光漸暗）', type: 'direction', role: null },
];
const translation = 'I will come back because I promised you.';
function plan(entries = [translation.split(' because')[0], 'because I promised you.', ''], sourceCues = cues) {
  return { groups: [{startCueId:sourceCues[0].id,endCueId:sourceCues[sourceCues.length-1].id,meaning:'承諾回來，燈光漸暗',reviewReason:''}],
    segments: sourceCues.map((cue,index) => ({kind:'subtitle',cueId:cue.id,text:entries[index] || ''})) };
}
const clone = value => JSON.parse(JSON.stringify(value));
const width = text => Array.from(text).reduce((sum,char) => sum + (/\s/u.test(char)?0.25:/[\p{Script=Han}\uff01-\uff60]/u.test(char)?1:0.5),0);
const options = { client: {}, cues, rawText: translation, languageName:'English',languageCode:'en',model:'gpt-4o-mini',targetWidth:60,measureText:width };

test('global allocation and audit both receive all original cues and the literal complete translation', async () => {
  const calls = [], phases = [];
  const result = await alignFullScript({...options,onProgress:phase=>phases.push(phase),request:async(_client,phase,payload)=>{
    calls.push({phase,payload});return phase==='audit'?{issues:[]}:plan();
  }});
  assert.deepEqual(calls.map(call=>call.phase),['allocate','audit']);
  for(const call of calls){assert.deepEqual(call.payload.primaryCues,cues);assert.equal(call.payload.fullTranslation,translation);}
  assert.equal(calls[1].payload.draft.segments.length,cues.length);
  assert.equal(result.rows[0].text,'I will come back');
  assert.equal(result.rows[1].text,'because I promised you.');
  assert.equal(result.rows[2].text,'');
  assert.ok(result.rows.every(row=>row.review===null));
  assert.equal(result.mode,'whole');
  assert.deepEqual(phases,['allocating','validating','auditing']);
});

test('validation reconstructs source punctuation, Unicode and whitespace instead of saving model-generated text', () => {
  const sourceCues=[{id:'a',text:'第一句'},{id:'b',text:'第二句'}];
  const original='你好𠮷野家😀！  I\twill come back.';
  const p=plan(['你好𠮷野家😀！','I will come back.'],sourceCues);
  const result=validatePlan(p,sourceCues,original);
  assert.equal(result.rows[0].text,'你好𠮷野家😀！');assert.equal(result.rows[1].text,'I\twill come back.');
  assert.equal(result.sourceText,original);
});

test('speaker and scene headers remain accounted for without appearing in spoken captions', () => {
  const sourceCues=[{id:'header',text:'第一幕',type:'direction'},...cues,{id:'bye',text:'晚安',type:'dialogue',role:'乙'}];
  const raw='ACT I\nAlice: I will come back because I promised you.\n(The lights dim.)\nBob: Good night.';
  const p=plan([],sourceCues);
  p.segments=[
    {kind:'heading',cueId:null,text:'ACT I'},{kind:'subtitle',cueId:'header',text:''},
    {kind:'speaker',cueId:null,text:'Alice:'},{kind:'subtitle',cueId:'cause',text:'I will come back'},
    {kind:'subtitle',cueId:'result',text:'because I promised you.'},{kind:'subtitle',cueId:'stage',text:'(The lights dim.)'},
    {kind:'speaker',cueId:null,text:'Bob:'},{kind:'subtitle',cueId:'bye',text:'Good night.'},
  ];
  const result=validatePlan(p,sourceCues,raw);
  assert.deepEqual(result.metadata.map(item=>item.text),['ACT I','Alice:','Bob:']);
  assert.equal(result.rows[3].text,'(The lights dim.)');assert.equal(result.rows[4].text,'Good night.');
});

test('missing, repeated, rewritten or reordered translation and altered cue structure are rejected', async t => {
  const cases={
    omitted:p=>{p.segments[1].text='because I promised';},
    rewritten:p=>{p.segments[0].text='I shall come back';},
    reordered:p=>{[p.segments[0].text,p.segments[1].text]=[p.segments[1].text,p.segments[0].text];},
    repeated:p=>{p.segments[1].text=translation;},
    cueOmitted:p=>{p.segments.pop();},
    cueDuplicated:p=>{p.segments[1].cueId='cause';},
    newCue:p=>{p.segments[2].cueId='new-cue';},
    cueReordered:p=>{[p.segments[0].cueId,p.segments[1].cueId]=['result','cause'];},
    invalidGroup:p=>{p.groups[0].startCueId='result';},
    hiddenDialogue:p=>{p.segments[0]={kind:'heading',cueId:null,text:'I will come back'};},
    wordSplit:p=>{p.segments[0].text='I will come ba';p.segments[1].text='ck because I promised you.';},
  };
  for(const [name,mutate] of Object.entries(cases)) await t.test(name,()=>{const p=plan();mutate(p);assert.throws(()=>validatePlan(p,cues,translation));});
});

test('a structurally invalid draft is repaired with the complete originals before the semantic audit', async () => {
  const calls=[];
  const result=await alignFullScript({...options,request:async(_client,phase,payload)=>{
    calls.push({phase,payload});return phase==='audit'?{issues:[]}:phase==='allocate'?plan(['I will come back','because I promised','']):plan();
  }});
  assert.deepEqual(calls.map(call=>call.phase),['allocate','repair','audit']);
  assert.equal(calls[1].payload.fullTranslation,translation);assert.deepEqual(calls[1].payload.primaryCues,cues);
  assert.equal(result.repairCount,1);
});

test('contractions, compound words and decimal numbers cannot be cut into separate cues', () => {
  const sourceCues=[{id:'a',text:'第一句'},{id:'b',text:'第二句'}];
  for (const [left,right] of [["don","'t leave."],["don't",' leave.'],['well-','known friend.'],['3.','14 meters.'],['1,','000 people.']]) {
    const original=left+right;
    if(left==="don't") assert.equal(validatePlan(plan([left,right.trim()],sourceCues),sourceCues,original).rows[0].text,"don't");
    else assert.throws(()=>validatePlan(plan([left,right],sourceCues),sourceCues,original),/單字或數字/);
  }
});

test('semantic repairs retain the full script and only change the affected cue range', async () => {
  const calls=[];let audits=0;
  const result=await alignFullScript({...options,request:async(_client,phase,payload)=>{
    calls.push({phase,payload});
    if(phase==='audit')return {issues:audits++===0?[{startCueId:'cause',endCueId:'result',reason:'兩格的英文切點不自然'}]:[]};
    return phase==='repair'?plan(['I will come back because','I promised you.','']):plan();
  }});
  assert.deepEqual(calls.map(call=>call.phase),['allocate','audit','repair','audit']);
  assert.deepEqual(calls[2].payload.allowedCueIds,['cause','result']);
  assert.equal(calls[2].payload.fullTranslation,translation);assert.equal(calls[2].payload.primaryCues.length,3);
  assert.equal(result.rows[2].text,'');assert.equal(result.repairCount,1);
});

test('bounded semantic repair leaves persistent uncertainty marked instead of looping or rewriting text', async () => {
  let repairs=0,audits=0;
  const result=await alignFullScript({...options,request:async(_client,phase)=>{
    if(phase==='repair')repairs++;
    if(phase==='audit'){audits++;return {issues:[{startCueId:'cause',endCueId:'result',reason:'請確認此完整意群'}]};}
    return plan();
  }});
  assert.equal(repairs,2);assert.equal(audits,3);
  assert.equal(result.rows[0].review.status,'review');assert.equal(result.rows[1].review.status,'review');
  assert.equal(result.rows[2].review,null);
  assert.equal(result.rows.map(row=>row.text).filter(Boolean).join(' '),translation);
});

test('repair cannot modify unaffected cues and malformed audits do not count as a successful full review', async () => {
  await assert.rejects(()=>alignFullScript({...options,request:async(_client,phase)=>phase==='audit'
    ?{issues:[{startCueId:'result',endCueId:'result',reason:'修正第二格'}]}
    :phase==='repair'?plan(['I will','come back because I promised you.','']):plan()}),/未要求調整/);
  assert.throws(()=>validateAudit({issues:[{startCueId:'fake',endCueId:'result',reason:'bad'}]},cues));
  assert.throws(()=>validateAudit({},cues));
});

test('empty dialogue and overlong translation are flagged without changing the original grid or deleting words', async () => {
  const raw='A'.repeat(160);
  const result=await alignFullScript({...options,rawText:raw,request:async(_client,phase)=>phase==='audit'?{issues:[]}:plan([raw,'',''])});
  assert.equal(result.rows.length,3);assert.equal(result.rows[0].text,raw);
  assert.match(result.rows[0].review.reason,/長度/);assert.match(result.rows[1].review.reason,/沒有分配/);assert.equal(result.rows[2].review,null);
});

test('request schema, selected model and truncation settings preserve the complete inputs', async () => {
  for(const model of ['gpt-4o-mini','gpt-4o','gpt-5.5']) {
    const request=buildRequest('allocate',{primaryCues:cues,fullTranslation:translation},{model});
    assert.equal(request.model,model);assert.equal(request.store,false);assert.equal(request.truncation,'disabled');
    assert.equal(request.text.format.strict,true);assert.equal(request.text.format.type,'json_schema');
    assert.equal(request.max_output_tokens,model==='gpt-5.5'?128000:16384);
    assert.match(request.input[0].content,/相鄰多格/);assert.match(request.input[0].content,/不得翻譯/);
    if(model==='gpt-5.5'){assert.deepEqual(request.reasoning,{effort:'medium'});assert.equal(request.temperature,undefined);}
  }
  assert.equal(buildRequest('audit',{}, {model:'gpt-5.5'}).max_output_tokens,32768);
  for(const response of [
    {status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:JSON.stringify(plan())},
    {status:'completed',output:[{type:'message',content:[{type:'refusal'}]}],output_text:JSON.stringify(plan())},
    {status:'completed',output_text:'{"groups":['},
  ])await assert.rejects(()=>requestJson({responses:{create:async()=>response}},'allocate',{}, {model:'gpt-4o-mini'}));
});

test('capacity fallback uses matching complete scenes, discloses reduced scope, and checks global text coverage', async () => {
  const sceneCues=[{id:'s1',text:'第一場',type:'direction'},{id:'a',text:'早安',type:'dialogue'},
    {id:'s2',text:'第二場',type:'direction'},{id:'b',text:'晚安',type:'dialogue'}];
  const raw='SCENE 1\nGood morning.\nSCENE 2\nGood night.';
  const calls=[];
  const result=await alignFullScript({...options,cues:sceneCues,rawText:raw,request:async(_client,phase,payload)=>{
    calls.push({phase,payload});
    if(payload.primaryCues.length===4)throw Object.assign(new Error('maximum context length'),{code:'context_length_exceeded'});
    if(phase==='audit')return {issues:[]};
    return plan(payload.fullTranslation.split('\n'),payload.primaryCues);
  }});
  assert.equal(result.mode,'scenes');assert.equal(result.rows.length,4);assert.equal(result.rows[3].text,'Good night.');
  assert.match(result.rows[1].review.reason,/未進行單次全文覆核/);
  assert.deepEqual(calls.map(call=>call.phase),['allocate','allocate','audit','allocate','audit']);
  assert.deepEqual(splitCompleteScenes(sceneCues,raw).map(scene=>scene.cues.length),[2,2]);
  const merged=clone(sceneCues);merged[0].text='第一場\n（燈光漸亮）';
  assert.equal(splitCompleteScenes(merged,raw).length,2);
  assert.equal(splitCompleteScenes(sceneCues,raw.replace('SCENE 2','SCENE 3')).length,0);
  await assert.rejects(()=>alignFullScript({...options,request:async()=>{throw Object.assign(new Error('maximum context length'),{code:'context_length_exceeded'});}}),/沒有可核對/);
});

test('review confirmation becomes stale when either original or translated text changes', () => {
  const review={...createReview(cues[0],'I will come back','請確認'),status:'confirmed'};
  assert.equal(normalizeAlignmentReviews({english:review},cues[0].text,{english:'I will come back'}).english.status,'confirmed');
  assert.equal(normalizeAlignmentReviews({english:review},'改過原文',{english:'I will come back'}).english.status,'stale');
  assert.equal(normalizeAlignmentReviews({english:review},cues[0].text,{english:'Changed'}).english.status,'stale');
  assert.deepEqual(normalizeAlignmentReviews({english:review},cues[0].text,{}),{});
});

test('rate limits never trigger capacity-based scene splitting and extra AI requests', async () => {
  const sourceCues=[{id:'s1',text:'第一場',type:'direction'},{id:'a',text:'早安',type:'dialogue'},
    {id:'s2',text:'第二場',type:'direction'},{id:'b',text:'晚安',type:'dialogue'}];
  let calls=0;
  await assert.rejects(()=>alignFullScript({...options,cues:sourceCues,rawText:'SCENE 1\nGood morning.\nSCENE 2\nGood night.',
    request:async()=>{calls++;throw Object.assign(new Error('too many tokens; rate limit'),{status:429,code:'rate_limit_exceeded'});}}),/rate limit/);
  assert.equal(calls,1);
});

test('real import route preserves IDs, original text, other languages, music and playback position; progress is request-scoped', async t => {
  const f=fixture({respond:async phase=>phase==='audit'?{issues:[]}:plan()});t.after(()=>f.dispose());
  const before=clone(f.session.lines),index=f.session.currentIndex;
  const response=await f.align(translation);assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(response.body.alignment.mode,'whole');assert.equal(response.body.alignment.reviewCount,0);
  assert.deepEqual(f.requests.map(request=>request.phase),['allocate','audit']);
  assert.equal(f.session.lines.length,before.length);assert.equal(f.session.currentIndex,index);
  for(let i=0;i<before.length;i++) {
    const {translations,...old}=before[i],{translations:updated,...now}=f.session.lines[i];
    assert.deepEqual(now,old);assert.equal(updated.french,translations.french);assert.equal(updated.primary,translations.primary);
  }
  assert.equal(f.session.lines[0].translations.english,'I will come back');
  assert.equal(f.session.lines[1].translations.english,'because I promised you.');assert.equal(f.session.lines[2].translations.english,'');
  assert.ok(f.session.cells.every(cell=>cell.lines===f.session.lines));assert.equal(f.writes.length,1);
  const progress=f.events.filter(event=>event.name==='alignment:progress');
  assert.deepEqual(progress.map(event=>event.payload.phase),['allocating','validating','auditing']);
  assert.ok(progress.every(event=>event.room===`control:${f.session.id}`&&event.payload.requestId==='test-request'));
  assert.equal(f.control().languageSources.english.text,translation);
});

test('failed allocation, failed audit and invalid repair leave the current subtitles and history intact', async t => {
  for(const failure of ['allocate','audit','repair']) await t.test(failure,async t=>{
    const f=fixture({respond:async phase=>{if(phase===failure)throw new Error('simulated failure');return phase==='audit'?{issues:[]}:plan(['I will come back','because I promised','']);}});t.after(()=>f.dispose());
    const before=clone(f.session.lines);const response=await f.align(translation);
    assert.equal(response.status,500);assert.deepEqual(f.session.lines,before);assert.equal(f.writes.length,0);
    assert.equal(f.session.history?.past.length || 0,0);
  });
});

test('a later scene failure in capacity fallback never writes an earlier completed scene', async t=>{
  const lines=[{id:'s1',text:'第一場',type:'direction'},{id:'a',text:'早安',type:'dialogue'},
    {id:'s2',text:'第二場',type:'direction'},{id:'b',text:'晚安',type:'dialogue'}];
  const f=fixture({lines,respond:async(phase,payload)=>{
    if(payload.primaryCues.length===4)throw Object.assign(new Error('maximum context length'),{code:'context_length_exceeded'});
    if(payload.primaryCues[0].id==='s2')throw new Error('第二場模擬失敗');
    return phase==='audit'?{issues:[]}:plan(payload.fullTranslation.split('\n'),payload.primaryCues);
  }});t.after(()=>f.dispose());
  const before=clone(f.session.lines);
  const response=await f.align('SCENE 1\nGood morning.\nSCENE 2\nGood night.');
  assert.equal(response.status,500);assert.equal(f.writes.length,0);assert.deepEqual(f.session.lines,before);
  assert.match(response.body.details,/原字幕尚未變更/);
});

test('ownership, primary language and missing original guards run before any AI work', async t=>{
  const f=fixture({respond:async()=>plan()});t.after(()=>f.dispose());
  assert.equal((await f.align(translation,{user:null})).status,401);
  assert.equal((await f.align(translation,{user:f.viewer})).status,403);
  assert.equal((await f.align(translation,{user:f.other})).status,404);
  assert.equal((await f.align(translation,{params:{languageId:'primary'}})).status,400);
  assert.equal(f.requests.length,0);
  const empty=fixture({lines:[],respond:async()=>plan()});t.after(()=>empty.dispose());
  assert.equal((await empty.align(translation)).status,400);assert.equal(empty.requests.length,0);
});

test('concurrent original or target edits reject the old job without overwriting the edit', async t=>{
  for(const languageId of ['primary','english'])await t.test(languageId,async t=>{
    let f;
    f=fixture({respond:async phase=>{if(phase==='audit'){f.socket('updateLine',{lineId:'cause',languageId,text:'人工修改'});return {issues:[]};}return plan();}});t.after(()=>f.dispose());
    const response=await f.align(translation);
    assert.equal(response.status,409);assert.equal(response.body.code,'ALIGNMENT_CONFLICT');
    assert.equal(f.session.lines[0].translations[languageId],'人工修改');assert.equal(f.writes.length,1);
    assert.equal(f.session.lines[1].translations.english,'old second');
  });
});

test('read-only normalization and other-language edits do not create false conflicts or lose unrelated edits', async t=>{
  let f;
  f=fixture({respond:async phase=>{
    if(phase==='audit'){f.refresh();f.socket('updateLine',{lineId:'cause',languageId:'french',text:'modification française'});return {issues:[]};}
    return plan();
  }});t.after(()=>f.dispose());
  const response=await f.align(translation);assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(f.session.lines[0].translations.french,'modification française');
  assert.equal(f.session.lines[0].translations.english,'I will come back');
});

test('scene navigation during alignment is preserved while the shared caption timeline updates', async t=>{
  let f;
  f=fixture({respond:async phase=>{
    if(phase==='audit'){f.session.selectedCellId='second-scene';f.refresh();return {issues:[]};}return plan();
  }});t.after(()=>f.dispose());
  const response=await f.align(translation);assert.equal(response.status,200,JSON.stringify(response.body));
  assert.equal(f.session.selectedCellId,'second-scene');assert.equal(f.session.lines[0].translations.english,'I will come back');
  assert.equal(f.session.cells[0].languageSources.english.text,translation);
});

test('deleted sessions and changed language settings invalidate a pending alignment', async t=>{
  for(const change of ['delete','language'])await t.test(change,async t=>{
    let f;
    f=fixture({respond:async phase=>{
      if(phase==='audit'){if(change==='delete')f.remove();else f.session.languages[1].code='fr';return {issues:[]};}return plan();
    }});t.after(()=>f.dispose());
    assert.equal((await f.align(translation)).status,409);assert.equal(f.writes.length,0);
  });
});

test('pending markers survive storage, reload, backup, confirmation and undo; viewers receive no review metadata', async t=>{
  const f=fixture({respond:async phase=>phase==='audit'?{issues:[{startCueId:'cause',endCueId:'result',reason:'請確認跨格因果語序'}]}:plan()});t.after(()=>f.dispose());
  const result=await f.align(translation);assert.equal(result.status,200);assert.equal(result.body.alignment.reviewCount,2);
  for(const session of [f.reload(),f.backup()])assert.equal(session.lines[0].alignmentReviews.english.status,'review');
  assert.equal(f.display().lines[0].alignmentReviews,undefined);
  const route='/api/session/:sessionId/lines/:lineId/languages/:languageId/alignment/confirm';
  assert.equal((await f.route('post',route,{params:{lineId:'cause'},body:{expectedText:'old',expectedPrimaryText:f.session.lines[0].text}})).status,409);
  assert.equal((await f.route('post',route,{user:f.other,params:{lineId:'cause'}})).status,404);
  const confirmed=await f.route('post',route,{params:{lineId:'cause'},body:{expectedText:'I will come back',expectedPrimaryText:f.session.lines[0].text}});
  assert.equal(confirmed.status,200);assert.equal(f.control().lines[0].alignmentReviews.english.status,'confirmed');
  await f.route('post','/api/session/:sessionId/undo');assert.equal(f.control().lines[0].alignmentReviews.english.status,'review');
  await f.route('post','/api/session/:sessionId/redo');assert.equal(f.control().lines[0].alignmentReviews.english.status,'confirmed');
  f.socket('updateLine',{lineId:'cause',languageId:'english',text:'I will definitely come back'});
  assert.equal(f.control().lines[0].alignmentReviews.english.status,'stale');
});
