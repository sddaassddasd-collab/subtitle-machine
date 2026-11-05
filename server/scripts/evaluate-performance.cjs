#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');
const {evaluatePerformance} = require('../src/performance-evaluation');
try {
  const {values} = parseArgs({options: {manifest: {type: 'string'}, output: {type: 'string'}}});
  if (!values.manifest) throw new Error('Usage: node scripts/evaluate-performance.cjs --manifest comparison.json [--output report.json]');
  const manifest = JSON.parse(fs.readFileSync(values.manifest, 'utf8'));
  const root = path.dirname(path.resolve(values.manifest));
  manifest.runs = manifest.runs.map(run => {
    if (!run.file) return run;
    const data = JSON.parse(fs.readFileSync(path.resolve(root, run.file), 'utf8'));
    return Array.isArray(data) ? {...run, revisions: data} : {...data, name: run.name || data.name};
  });
  const output = JSON.stringify(evaluatePerformance(manifest), null, 2) + '\n';
  if (values.output) fs.writeFileSync(values.output, output); else process.stdout.write(output);
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
