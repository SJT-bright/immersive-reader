// F1-1 / F1-11：元数据长度口径与数据目录解析，两侧（scripts/library_store.py 与
// cloud/server.js）必须是同一个规则。
// 纯 node 运行，不开端口、不联网：Python 侧直接调 LibraryStore（/tmp 临时库），
// Node 侧 require cloud/server.js 导出的同一批函数（READER_DATA_DIR 指向 /tmp）。
// 运行：node --test tests/fix1-metadata-parity.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = () => mkdtempSync(join(tmpdir(), 'fix1-meta-'))

// Node 侧：把 READER_DATA_DIR 指到 /tmp 的一次性目录再 require，绝不碰本机正式书库
const dataDir = scratch()
process.env.READER_DATA_DIR = dataDir
process.env.READER_NO_OPEN = '1'
const node = require(join(ROOT, 'cloud', 'server.js'))

// Python 侧：子进程导入同一份 library_store。大 payload 走临时文件而不是 argv
//（macOS 的 ARG_MAX 会把 2MB 参数直接顶掉）。
function python (script, { file = null, argv = [], env = {} } = {}) {
    const args = file !== null ? ['-c', script, file, ...argv] : ['-c', script, ...argv]
    const result = spawnSync('python3', args, {
        cwd: ROOT, encoding: 'utf8',
        // READER_DATA_DIR 默认清空：两侧必须各写各的库，否则 Node 的 env 会
        // 把 Python 子进程拽进同一个 sqlite 文件，比较就失去意义了。
        env: { ...process.env, PYTHONPATH: join(ROOT, 'scripts'), READER_DATA_DIR: '', ...env },
        maxBuffer: 32 * 1024 * 1024,
    })
    if (result.status !== 0) {
        throw new Error('python 侧失败 status=' + result.status + ' ' + (result.stderr || '') + (result.stdout || ''))
    }
    return result.stdout.trim()
}
function pySizeOf (meta) {
    const dir = scratch()
    try {
        const path = join(dir, 'meta.json')
        writeFileSync(path, JSON.stringify(meta))
        return Number(python('import json,sys,library_store as ls; print(ls.encoded_meta_size(json.load(open(sys.argv[1]))))', { file: path }))
    } finally { rmSync(dir, { recursive: true, force: true }) }
}
function nodeProbe (script, env = {}) {
    const result = spawnSync(process.execPath, ['-e', script], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env },
    })
    if (result.status !== 0) throw new Error('node 侧失败：' + (result.stderr || result.stdout))
    return result.stdout.trim()
}

test.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
})

// ---------- F1-1：口径统一 ----------

const cjkMeta = {
    id: 'book-1',
    title: '山中的信：第三章·夜里的雨窗与灯下长读',
    notes: Array.from({ length: 200 }, (_, i) => ({
        id: 'n' + i, type: 'quote', cfi: 'epubcfi(/6/2!/4/2/' + i + ')',
        text: '原文第' + i + '条，汉字占多数，转义与否差六倍。',
        comment: '心得：这里写得安静。', createdAt: i, editedAt: i,
    })),
}

test('同一份 meta 在两侧的字节长度完全一致（汉字不再被转义成 6 字符）', () => {
    assert.equal(pySizeOf(cjkMeta), node.encodedMetaSize(cjkMeta),
        'Python 与 Node 算出的元数据长度必须相同')
})

test('旧口径让两侧容量差约 6 倍：同一份中文元数据必须同时通过或同时被拒', () => {
    // 单个汉字在 ensure_ascii=True 下变成 \uXXXX 共 6 个字符，Node 侧不转义只占 1 个
    // 字符 —— 中文为主的记录，两侧「同一个数字」实际容量差约 6 倍。
    const pureCjk = { id: 'b', title: '雨'.repeat(1000) }
    const escapedLength = JSON.stringify(pureCjk)
        .replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).length
    const nodeLength = JSON.stringify(pureCjk).length
    assert.ok(escapedLength / nodeLength > 5, '汉字为主的记录里转义长度应接近 Node 的 6 倍，实测 '
        + (escapedLength / nodeLength).toFixed(2) + ' 倍')
    // 挑一份「旧 Python 判超限、Node 却放行」的中文元数据，新口径下两侧必须同结论
    const divider = { id: 'book-1', title: '雨'.repeat(40000), notes: [] }
    const dividerEscaped = JSON.stringify(divider)
        .replace(/[^\x00-\x7f]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).length
    assert.ok(dividerEscaped > 200000, '这份元数据在旧 Python 口径下会被判超限')
    assert.ok(JSON.stringify(divider).length < 200000, '同一份在 Node 侧却远未超限 —— 就是那条缺陷')
    const dir = scratch()
    const path = join(dir, 'm.json')
    try {
        writeFileSync(path, JSON.stringify(divider))
        assert.equal(pySizeOf(divider), Buffer.byteLength(JSON.stringify(divider), 'utf8'))
        assert.doesNotThrow(() => node.assertMetaSize(divider), '新口径下 Node 不该拒')
        python('import json,sys,library_store as ls; ls.encode_meta(json.load(open(sys.argv[1])))',
            { argv: [path] })   // 抛错即为 Python 仍按旧口径误判超限
    } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('上限两侧统一为 2_000_000 字节，且超长给出可识别的永久错误码', () => {
    assert.equal(node.MAX_METADATA_BYTES, 2000000)
    assert.equal(Number(python('import library_store as ls; print(ls.MAX_METADATA_BYTES)')),
        node.MAX_METADATA_BYTES, '两侧上限常量必须一致')
    const wide = { id: 'book-1', title: '测'.repeat(700000), notes: [] } // 约 2.1MB
    const dir = scratch()
    const path = join(dir, 'wide.json')
    writeFileSync(path, JSON.stringify(wide))
    try {
        const pyError = python('import json,sys,library_store as ls\n'
            + 'try:\n    ls.encode_meta(json.load(open(sys.argv[1]))); print("ACCEPTED")\n'
            + 'except ls.PermanentError as e:\n    print(e.code + "|" + str(e))', { file: path })
        assert.match(pyError, /^metadata_too_large\|Metadata too large: \d+$/, 'Python 侧要带 code 和实际长度')
        let nodeError = null
        try { node.assertMetaSize(wide) } catch (error) { nodeError = error }
        assert.ok(nodeError, 'Node 侧必须拒绝同一份超长元数据')
        assert.equal(nodeError.code, 'metadata_too_large')
        assert.equal(nodeError.message, pyError.split('|').slice(1).join('|'), '两侧错误文案（含字节数）一致')
    } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('同一份合法元数据两侧都放行，且 Python 入库用的就是校验用的紧凑串', () => {
    const dir = scratch()
    const path = join(dir, 'meta.json')
    try {
        writeFileSync(path, JSON.stringify(cjkMeta))
        const out = python(`
import json, sys, sqlite3
from pathlib import Path
import library_store as ls
meta = json.load(open(sys.argv[1]))
store = ls.LibraryStore(Path(sys.argv[2]), 19299)
store.run({'op':'put','store':'books','id':'book-1','meta':meta,'data':'YQ==','mime':'text/plain'})
raw = sqlite3.connect(store.path).execute("SELECT meta FROM records WHERE store='books' AND id='book-1'").fetchone()[0]
print(json.dumps({'stored_bytes': len(raw.encode('utf-8')), 'escaped': '\\\\u5c71' in raw,
                  'size': ls.encoded_meta_size(json.loads(raw)), 'same_string': raw == ls.encode_meta(meta)}))
`, { argv: [path, dir] })
        const saved = JSON.parse(out)
        assert.equal(saved.escaped, false, '入库串不能是转义版')
        assert.equal(saved.same_string, true, '判长用的串与落盘的串逐字节相同')
        assert.equal(saved.size, node.encodedMetaSize(cjkMeta), '入库后的长度与 Node 口径一致')
        assert.equal(saved.stored_bytes, saved.size, '校验用的长度就是实际入库的长度（不再是判 A 存 B）')
        assert.equal(saved.stored_bytes, Buffer.byteLength(JSON.stringify(cjkMeta), 'utf8'),
            'Python 落盘的字节数与 Node JSON.stringify 完全一致')
    } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- F1-11：READER_DATA_DIR 优先级 ----------

test('非 8940 端口时 READER_DATA_DIR 仍然优先，两侧解析到同一个库文件', () => {
    const dir = scratch()
    try {
        const pyPath = python(
            'import sys; from pathlib import Path; import library_store as ls;'
            + ' print(ls.LibraryStore(Path(sys.argv[1]), 8941).path)',
            { argv: [dir], env: { READER_DATA_DIR: dir } })
        assert.equal(pyPath, join(dir, 'library.sqlite3'),
            'Python 侧必须认 env，而不是退回 .preview/data-8941')
        assert.equal(existsSync(join(dir, '.preview')), false, '不该在 env 目录下再开 .preview 分支')
        const nodePath = nodeProbe(
            'process.stdout.write(require("./cloud/server.js").DATA_DIR + "/library.sqlite3")',
            { READER_DATA_DIR: dir, PORT: '8941' })
        assert.equal(nodePath, pyPath, '同一 env + 同一端口，Node 与 Python 必须落在同一个库文件')
    } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('没设 READER_DATA_DIR 时 Python 仍按端口分目录（原有行为不变）', () => {
    // 只拿 /tmp 下的假 root 试端口分支，绝不在工作区或本机正式库里建目录
    const root = scratch()
    try {
        const pyPath = python(
            'import sys; from pathlib import Path; import library_store as ls;'
            + ' print(ls.LibraryStore(Path(sys.argv[1]), 8941).path)',
            { argv: [root], env: { READER_DATA_DIR: '' } })
        assert.equal(pyPath, join(root, '.preview', 'data-8941', 'library.sqlite3'),
            'env 为空串时按「未设置」处理，走端口分支（与 cloud/server.js 的 resolveDataDir 一致）')
        const withEnv = python(
            'import sys; from pathlib import Path; import library_store as ls;'
            + ' print(ls.LibraryStore(Path(sys.argv[1]), 8941).path)',
            { argv: [root], env: { READER_DATA_DIR: join(root, 'given') } })
        assert.equal(withEnv, join(root, 'given', 'library.sqlite3'), 'env 一旦设置就压过端口分支')
    } finally { rmSync(root, { recursive: true, force: true }) }
})
