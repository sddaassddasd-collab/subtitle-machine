#!/usr/bin/env node
const fs = require('node:fs');
const {evaluateAcoustic} = require('../src/acoustic-evaluation');
const {parseArgs} = require('node:util');
try {
  const {values} = parseArgs({options: {
    'reference-pcm': {type: 'string'}, 'live-pcm': {type: 'string'}, segments: {type: 'string'},
    'live-sample-rate': {type: 'string', default: '24000'}, 'live-timeline': {type: 'string'}, output: {type: 'string'},
  }});
  if (!values['reference-pcm'] || !values['live-pcm'] || !values.segments) {
    throw new Error('Usage: node scripts/evaluate-acoustic.cjs --reference-pcm reference-16k.pcm --live-pcm live-24k.pcm --segments segments.json [--live-sample-rate 24000] [--live-timeline timeline.json] [--output report.json]');
  }
  const report = evaluateAcoustic({referencePcm: fs.readFileSync(values['reference-pcm']),
    livePcm: fs.readFileSync(values['live-pcm']), sampleRate: Number(values['live-sample-rate']),
    segments: JSON.parse(fs.readFileSync(values.segments, 'utf8')),
    liveTimeline: values['live-timeline'] ? JSON.parse(fs.readFileSync(values['live-timeline'], 'utf8')) : []});
  const output = JSON.stringify(report, null, 2) + '\n';
  if (values.output) fs.writeFileSync(values.output, output);
  else process.stdout.write(output);
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
