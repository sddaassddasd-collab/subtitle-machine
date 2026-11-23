const THEATRE_DISCUSSION_CONTEXT = '這是劇場或舞台劇的演前導聆、演前座談或演後座談。主題可能包括表演、導演、編劇、舞台設計與演出製作。請依上下文使用劇場及文化藝術領域的慣用術語，例如讀劇、排練、走位、舞台調度、燈光設計、音效設計、舞台監督、謝幕及演後交流。保留講者原意，只有讀音與語意都支持時才校正，不確定時保留原文。';

const THEATRE_TERMS = {
  'zh-TW': '劇場、舞台劇、演前導聆、演前座談、演後座談、讀劇、排練、走位、舞台調度、燈光設計、音效設計、舞台設計、舞台監督、謝幕、演後交流',
  en: 'theatre,stage play,pre-show talk,post-show discussion,staged reading,rehearsal,blocking,lighting design,sound design,set design,stage manager,curtain call,talkback',
  ja: '演劇、舞台公演、プレトーク、アフタートーク、朗読劇、稽古、立ち位置、舞台美術、照明デザイン、音響、舞台監督、カーテンコール',
  ko: '연극,무대 공연,공연 전 해설,관객과의 대화,낭독극,리허설,무대 동선,조명 디자인,음향 디자인,무대감독,커튼콜',
  es: 'teatro,obra teatral,charla previa,coloquio,lectura dramatizada,ensayo,puesta en escena,diseño de iluminación,diseño de sonido,regiduría,saludo final',
  fr: 'théâtre,pièce de théâtre,avant-spectacle,après-spectacle,lecture mise en espace,répétition,mise en scène,création lumière,création sonore,régie plateau,salut final',
  de: 'Theater,Schauspiel,Einführung,Nachgespräch,szenische Lesung,Probe,Bühnenregie,Lichtdesign,Tondesign,Inspizienz,Schlussapplaus',
};

function discussionContext(userContext, discussion) {
  return discussion ? [THEATRE_DISCUSSION_CONTEXT, userContext].filter(Boolean).join('\n\n') : userContext;
}

module.exports = {THEATRE_DISCUSSION_CONTEXT, THEATRE_TERMS, discussionContext};
