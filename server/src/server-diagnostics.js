const fs = require('node:fs');
const path = require('node:path');
function localCommit() {
  try {
    const git = path.resolve(__dirname, '../../.git');
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: ') ? fs.readFileSync(path.join(git, head.slice(5)), 'utf8').trim() : head;
  } catch { return null; }
}
const metadata = Object.freeze({commit: process.env.RENDER_GIT_COMMIT || process.env.GITHUB_SHA || process.env.SOURCE_VERSION || localCommit(),
  node: process.version, version: require('../package.json').version, startedAt: Date.now(), diagnosticsVersion: 1});
module.exports = {serverDiagnosticMetadata: () => metadata};
