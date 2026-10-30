const {execFileSync} = require('node:child_process');
const path = require('node:path');
let commit = process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION || process.env.GIT_COMMIT || '';
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: path.join(__dirname, '../..'), timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']}).toString().trim(); }
  catch { commit = 'unknown'; }
}
module.exports = Object.freeze({commit: commit.slice(0, 80), version: require('../package.json').version,
  node: process.version, startedAt: new Date().toISOString()});
