// Windows / Linux 资料目录必须和 macOS 分开，并且 Node、桌面壳、Python 三条路径一致。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// server.js 在被 require 时就会打开 SQLite。先把库指到临时目录，避免碰到正式书库。
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-win-'))
process.env.READER_DATA_DIR = scratch
process.env.READER_NO_OPEN = '1'
process.env.PORT = '18940'
const { defaultLibraryDir } = require('../cloud/server.js')
const { defaultLibraryDir: desktopDir } = require('../desktop/supervisor.cjs')
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }))

const cases = [
    ['darwin', '/Users/ada', {}, '/Users/ada/Library/Application Support/immersive-reader-app/library'],
    ['win32', 'C:\\Users\\ada', { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'C:\\Users\\ada\\AppData\\Roaming\\immersive-reader-app\\library'],
    ['win32', 'C:\\Users\\ada', {}, 'C:\\Users\\ada\\AppData\\Roaming\\immersive-reader-app\\library'],
    ['linux', '/home/ada', {}, '/home/ada/.local/share/immersive-reader-app/library'],
    ['linux', '/home/ada', { XDG_DATA_HOME: '/home/ada/data' }, '/home/ada/data/immersive-reader-app/library'],
]

test('Node 服务与桌面壳按系统选择书库目录', () => {
    for (const [platform, home, env, expected] of cases) {
        assert.equal(defaultLibraryDir(platform, home, env), expected, platform)
        assert.equal(desktopDir(platform, home, env), expected, 'desktop ' + platform)
    }
})

test('Python default_library_dir 与 Node 落到同一路径', () => {
    const script = `
import json, library_store as ls
cases = [
  ('darwin', '/Users/ada', {}),
  ('win32', r'C:\\Users\\ada', {'APPDATA': r'C:\\Users\\ada\\AppData\\Roaming'}),
  ('win32', r'C:\\Users\\ada', {}),
  ('linux', '/home/ada', {}),
  ('linux', '/home/ada', {'XDG_DATA_HOME': '/home/ada/data'}),
]
print(json.dumps([str(ls.default_library_dir(p, h, e)) for p, h, e in cases]))
`
    const result = spawnSync('python3', ['-c', script], {
        cwd: path.join(ROOT, 'scripts'),
        encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    const paths = JSON.parse(result.stdout)
    assert.deepEqual(paths, cases.map((item) => item[3]))
})

test('start.bat 使用 CRLF，并优先 Node、再退回 Python', () => {
    const raw = fs.readFileSync(path.join(ROOT, 'start.bat'))
    const text = raw.toString('utf8')
    assert.equal(text.includes('\r\n'), true)
    assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, 'start.bat 不能混用 LF，否则 cmd 会把下一行粘进命令')
    assert.match(text, /node cloud\\server\.js/)
    assert.match(text, /py -3 scripts\\serve\.py/)
    assert.match(text, /python scripts\\serve\.py/)
})
