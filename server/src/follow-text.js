const OpenCC = require('opencc-js');
const traditionalize = OpenCC.Converter({from: 'cn', to: 'twp'});
function normalizeText(text) {
  return traditionalize(String(text || '').normalize('NFKC'))
    .replace(/[（(][^（）()]{0,80}[）)]/gu, '')
    .replace(/[\p{P}\p{Z}\p{S}\s]/gu, '').toLocaleLowerCase();
}
module.exports = {normalizeText};
