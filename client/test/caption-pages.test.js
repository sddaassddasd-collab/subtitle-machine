import {test} from 'node:test'
import assert from 'node:assert/strict'
import Module, {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {buildSync} from 'esbuild'
import React from 'react'
import {renderToString} from 'react-dom/server'
import {MemoryRouter, Routes, Route} from 'react-router-dom'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const [page, route] of [['ViewerPage', '/viewer/:viewerToken'], ['ProjectorPage', '/projector/:projectorToken']]) {
  test(`${page} initializes the actual caption page without browser state or live services`, () => {
    const code = buildSync({entryPoints: [path.join(root, 'src/pages', `${page}.jsx`)], bundle: true, write: false,
      platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic'}).outputFiles[0].text
    const filename = path.join(root, 'test', 'render-check.cjs')
    const compiled = new Module(filename)
    compiled.filename = filename
    compiled.paths = Module._nodeModulePaths(root)
    compiled.require = createRequire(filename)
    compiled._compile(code, filename)
    const html = renderToString(React.createElement(MemoryRouter, {initialEntries: [route.replace(/:[^/]+/, 'test')]},
      React.createElement(Routes, null, React.createElement(Route, {path: route, element: React.createElement(compiled.exports.default)}))))
    assert.ok(html.includes(page === 'ViewerPage' ? 'viewer-page' : 'projector-page'))
  })
}

test('control output preview renders the canonical held caption, bilingual translations and masking', () => {
  const code = buildSync({entryPoints: [path.join(root, 'src/components/ControlOutputPreview.jsx')], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic'}).outputFiles[0].text
  const filename = path.join(root, 'test', 'render-check.cjs'), compiled = new Module(filename)
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(root); compiled.require = createRequire(filename)
  compiled._compile(code, filename)
  const output = {sessionId: 'test', displayEnabled: true, source: 'transcription',
    languages: [{id: 'primary'}, {id: 'en'}], defaultLanguageId: 'primary', secondaryLanguageId: 'en', languageMode: 'bilingual',
    line: {text: '目前保留的現場台詞'}, liveEntries: [{id: 'a', text: '目前保留的現場台詞', translations: {en: 'Held spoken words'}}],
    captionPresentation: {performance: true, handoffIndex: 3, languageCodes: {primary: 'source', en: 'en'}}}
  const render = payload => renderToString(React.createElement(compiled.exports.default, {payload, scope: 'test'}))
  const html = render(output)
  assert.ok(html.includes('目前保留的現場台詞')); assert.ok(html.includes('Held spoken words'))
  assert.ok(!render({...output, displayEnabled: false}).includes('目前保留的現場台詞'))
  assert.ok(!render({...output, displayEnabled: false}).includes('Held spoken words'))
  const manual = render({...output, captionPresentation: {performance: false}})
  assert.equal(manual.split('目前保留的現場台詞').length - 1, 1)
})
