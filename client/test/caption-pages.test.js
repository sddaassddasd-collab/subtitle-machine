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
