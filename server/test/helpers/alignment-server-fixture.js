const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

module.exports = function fixture({ respond, lines, languages, liveIO = false } = {}) {
  const requests = [];
  class FakeOpenAI {
    constructor() {
      this.responses = { create: async request => {
        const prompt = request.input[1].content, marker = '全文資料：\n';
        const payload = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length));
        const phase = request.text.format.name === 'subtitle_alignment_audit' ? 'audit' : prompt.startsWith('修正') ? 'repair' : 'allocate';
        requests.push({ phase, payload, request });
        const result = await respond(phase, payload, request);
        return result?.status ? result : { status: 'completed', output_text: JSON.stringify(result) };
      } };
    }
  }
  const filename = require.resolve('../../src/server');
  const source = fs.readFileSync(filename, 'utf8');
  assert.match(source, /startServer\(\);\s*$/);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => name === 'openai' ? { OpenAI: FakeOpenAI } : originalRequire(name);
  loaded._compile(source.replace(/startServer\(\);\s*$/, `
    module.exports = function(lines, languages, liveIO) {
      const owner = { id: 'alignment-owner', username: 'alignment-test', role: USER_ROLES.OPERATOR };
      const other = { id: 'alignment-other', role: USER_ROLES.OPERATOR };
      const viewer = { id: 'alignment-viewer', role: USER_ROLES.VIEWER };
      [owner, other, viewer].forEach(user => users.set(user.id, user));
      const token = 'alignment-test-cookie';
      authSessions.set(hashToken(token), { userId: owner.id, tokenHash: hashToken(token), expiresAt: Date.now() + 600000 });
      const session = createSessionRecord(owner.id);
      session.languages = languages || [{id:'primary',name:'中文',code:'zh-TW'}, {id:'english',name:'English',code:'en'}, {id:'french',name:'Français',code:'fr'}];
      session.cells[0].lines = (lines || [
        { id:'cause',text:'因為我答應過你，',role:'甲',music:true,musicCueId:'song',musicText:'音樂播放中',translations:{primary:'因為我答應過你，',english:'old first',french:'ancien premier'} },
        { id:'result',text:'所以我一定會回來。',role:'甲',translations:{primary:'所以我一定會回來。',english:'old second',french:'ancien deuxième'} },
        { id:'stage',text:'（燈光漸暗）',type:'direction',translations:{primary:'（燈光漸暗）',english:'old stage'} },
      ]).map(line => createLineRecord(line));
      syncSelectedCellLines(session);
      session.cells.push(createCellDefinition({id:'second-scene',name:'第二場次',lines:session.lines}));
      session.currentIndex = Math.min(1, session.lines.length - 1);
      sessions.set(session.id, session);
      const writes = [], events = [];
      persistSession = s => writes.push(serializeSessionForStorage(s));
      broadcastControlState = s => {
        const payload = getControlPayload(getSession(s));
        events.push({name:'control:update',payload});
        if(liveIO) io.to('control:'+s).emit('control:update',payload);
      };
      broadcastViewerState = () => {};
      const originalTo = io.to.bind(io);
      io.to = room => ({emit:(name,payload)=>{
        events.push({room,name,payload});
        if(liveIO) originalTo(room).emit(name,payload);
      }});
      const handlers = new Map();
      io.listeners('connection')[0]({id:'alignment-socket',data:{},handshake:{headers:{cookie:AUTH_COOKIE_NAME+'='+token}},
        on:(name,handler)=>handlers.set(name,handler),emit(){}});
      return { app, server, session, owner, other, viewer, writes, events, cookie: AUTH_COOKIE_NAME + '=' + token,
        async route(method, routePath, {body = {}, params = {}, user = owner} = {}) {
          const route = app.router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]).route;
          const req = {authUser:user,params:{sessionId:session.id,cellId:session.cells[0].id,languageId:'english',...params},body};
          const res = {code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
          for(const layer of route.stack){let proceed=false;await layer.handle(req,res,()=>{proceed=true;});if(!proceed)break;}
          return {status:res.code,body:res.body};
        },
        socket(name, payload) { let response; handlers.get(name)({sessionId:session.id,...payload},result=>{response=result;}); return response; },
        control:()=>getControlPayload(session),
        display:()=>getViewerPayload(session),
        store:()=>serializeSessionForStorage(session),
        reload:()=>ensureSessionStructure(JSON.parse(JSON.stringify(serializeSessionForStorage(session)))),
        backup:()=>createImportedSessionFromBackup(buildSessionBackupPayload(session),owner),
        refresh:()=>ensureSessionStructure(session),
        remove:()=>sessions.delete(session.id),
        dispose(){for(const timer of currentIndexPersistTimers.values())clearTimeout(timer);
          for(const timer of latestRoomStateKeyframes.values())clearTimeout(timer.timer || timer);},
      };
    };
  `), filename);
  const f = loaded.exports(lines, languages, liveIO);
  return { ...f, requests, align: (text, options = {}) => {
    const { body, ...rest } = options;
    return f.route('post', '/api/session/:sessionId/cells/:cellId/languages/:languageId/parse', {
      ...rest, body: { apiKey: 'test-placeholder', scriptText: text, scriptParseModel: 'gpt-4o-mini', alignmentRequestId: 'test-request', ...body },
    });
  } };
};
