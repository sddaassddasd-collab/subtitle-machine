#!/usr/bin/env node
const fs = require('node:fs');
const {parseArgs} = require('node:util');
const {replayFollow} = require('../src/follow-replay');
try {
  const {values} = parseArgs({options: {input: {type: 'string'}, output: {type: 'string'}}});
  if (!values.input) throw new Error('Usage: node scripts/replay-follow.cjs --input follow.json [--output replay.json]');
  const report = JSON.parse(fs.readFileSync(values.input, 'utf8'));
  const output = JSON.stringify(replayFollow(report), null, 2) + '\n';
  if (values.output) fs.writeFileSync(values.output, output);
  else process.stdout.write(output);
} catch (error) {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
}
