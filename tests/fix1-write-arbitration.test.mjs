// F1-3 / F1-4 / F1-12：books 整条写入的时间戳与墓碑裁决，两侧必须给出同样的结果。
// 缺陷原文：scripts/library_store.py 的 op:'put' 是裸 INSERT OR REPLACE，没有任何裁决，
// 陈旧整条快照会把另一端刚写的进度与笔记回滚掉；cloud/server.js 同样。
// 纯 node 运行：Python 侧直接调 LibraryStore（/tmp 临时库），Node 侧 require
// cloud/server.js 的 runStore（READER_DATA_DIR 指向 /tmp），不开端口、不联网。
// 运行：node --test tests/fix1-write-arbitration.mjs
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
const scratch = (prefix = 'fix1-put-') => mkdtempSync(join(tmpdir(), prefix))

const nodeDir = scratch('fix1-put-node-')
process.env.READER_DATA_DIR = nodeDir
process.env.READER_NO_OPEN = '1'
const node = require(join(ROOT, 'cloud', 'server.js'))

function python (script, { argv = [], env = {} } = {}) {
    const result = spawnSync('python3', ['-c', script, ...argv], {
        cwd: ROOT, encoding: 'utf8',
        // READER_DATA_DIR 默认清空：两侧必须各写各的库，否则 Node 的 env 会
        // 把 Python 子进程拽进同一个 sqlite 文件，比较就失去意义了。
        env: { ...process.env, PYTHONPATH: join(ROOT, 'scripts'), READER_DATA_DIR: '', ...env },
        maxBuffer: 32 * 1024 * 1024,
    })
    if (result.status !== 0) throw new Error('python 侧失败 status=' + result.status + ' ' + (result.stderr || '') + (result.stdout || ''))
    return result.stdout.trim()
}

// 一条 Python 会话跑完整个操作序列，返回每步 get 的结果（JSON 逐字节可比较）
const PY_SEQUENCE = `
import json, sys
from pathlib import Path
import library_store as ls
store = ls.LibraryStore(Path(sys.argv[1]), 19298)
steps = json.load(open(sys.argv[2]))
out = []
for step in steps:
    try:
        out.append({'ok': True, 'result': store.run(step)})
    except Exception as error:
        out.append({'ok': False, 'error': str(error), 'code': getattr(error, 'code', None)})
print(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
`
function runSequence (steps) {
    const pyDir = scratch('fix1-put-py-')
    const stepsFile = join(pyDir, 'steps.json')
    writeFileSync(stepsFile, JSON.stringify(steps))
    try {
        const pyResults = JSON.parse(python(PY_SEQUENCE, { argv: [pyDir, stepsFile] }))
        const nodeResults = steps.map(step => {
            try { return { ok: true, result: node.runStore(step) } }
            catch (error) { return { ok: false, error: String(error.message), code: error.code || null } }
        })
        return { py: pyResults, node: nodeResults }
    } finally { rmSync(pyDir, { recursive: true, force: true }) }
}
// get 会带回二进制（base64），比较裁决结果时把它剔除；两侧都只比元数据
function stripBinary (results) {
    return JSON.parse(JSON.stringify(results, (key, value) =>
        (key === 'data' || key === 'mime') ? undefined : value))
}
function bothSides (results, assertion) {
    for (const side of ['py', 'node']) assertion(side, results[side])
    assert.deepEqual(stripBinary(results.py), stripBinary(results.node),
        'Python 与 Node 必须给出逐字段一致的裁决结果')
}

const note = (id, editedAt, extra = {}) => ({
    id, type: 'quote', cfi: 'epubcfi(/6/2!/4/2/' + id + ')', text: id + ' 原文。',
    comment: '心得', createdAt: editedAt - 5, editedAt, ...extra,
})
const tombstone = (id, editedAt, deletedAt) => ({
    ...note(id, editedAt), text: '', comment: '', editedAt: deletedAt, deletedAt,
})

// ---------- F1-3：陈旧整条 put 不再回滚 ----------

test('陈旧整条 put 不回滚较新的 progress（按 progress.at 择新）', () => {
    const fresh = { id: 'A-fresh', lastOpenedAt: 500, progress: { at: 500, fraction: 0.9, cfi: 'epubcfi(/6/9)' }, notes: [] }
    const stale = { id: 'A-fresh', lastOpenedAt: 100, progress: { at: 100, fraction: 0.1, cfi: 'epubcfi(/6/2)' }, notes: [] }
    const results = runSequence([
        { op: 'put', store: 'books', id: 'A-fresh', meta: fresh, data: 'YQ==', mime: 'text/plain' },
        { op: 'put', store: 'books', id: 'A-fresh', meta: stale, data: 'YQ==', mime: 'text/plain' },
        { op: 'get', store: 'books', id: 'A-fresh' },
    ])
    bothSides(results, (side, list) => {
        const got = list[2].result
        assert.equal(got.progress.fraction, 0.9, side + '：陈旧快照把进度回滚成 ' + JSON.stringify(got.progress))
        assert.equal(got.lastOpenedAt, 500, side + '：lastOpenedAt 应取大')
    })
})

test('陈旧整条 put 不回滚较新的笔记，也不丢掉另一端独有的笔记', () => {
    const results = runSequence([
        { op: 'put', store: 'books', id: 'B-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'B-1', lastOpenedAt: 500, notes: [note('keep', 500), note('edited', 500)] } },
        { op: 'put', store: 'books', id: 'B-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'B-1', lastOpenedAt: 100, notes: [note('edited', 200, { comment: '旧版本' })] } },
        { op: 'get', store: 'books', id: 'B-1' },
    ])
    bothSides(results, (side, list) => {
        const notesSaved = list[2].result.notes
        assert.equal(notesSaved.find(n => n.id === 'keep').text, 'keep 原文。', side + '：磁盘独有的笔记被陈旧快照抹掉了')
        assert.equal(notesSaved.find(n => n.id === 'edited').editedAt, 500, side + '：较新的笔记被旧编辑覆盖')
    })
})

test('磁盘上的删除标记压得住陈旧快照里的活副本（put 与 meta 同规则）', () => {
    const results = runSequence([
        { op: 'put', store: 'books', id: 'C-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'C-1', lastOpenedAt: 100, notes: [note('x', 1000)] } },
        { op: 'note', store: 'books', id: 'C-1', note: tombstone('x', 1000, 2000) },
        { op: 'put', store: 'books', id: 'C-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'C-1', lastOpenedAt: 1000, notes: [note('x', 1000)] } },
        { op: 'get', store: 'books', id: 'C-1' },
        { op: 'meta', store: 'books', id: 'C-1',
            meta: { id: 'C-1', lastOpenedAt: 1000, notes: [note('x', 1000)] } },
        { op: 'get', store: 'books', id: 'C-1' },
    ])
    bothSides(results, (side, list) => {
        assert.equal(list[3].result.notes.find(n => n.id === 'x').deletedAt, 2000,
            side + '：陈旧整条 put 让已删划线复活了')
        assert.equal(list[5].result.notes.find(n => n.id === 'x').deletedAt, 2000,
            side + '：陈旧 meta 写入让已删划线复活了')
    })
})

test('较新的整条 put 照常生效；replace:true 是明确的替换意图，不参与裁决', () => {
    const results = runSequence([
        { op: 'put', store: 'books', id: 'D-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'D-1', lastOpenedAt: 900, notes: [note('old', 900)] } },
        { op: 'put', store: 'books', id: 'D-1', data: 'YQ==', mime: 'text/plain', replace: true,
            meta: { id: 'D-1', lastOpenedAt: 10, notes: [], progress: { at: 10, fraction: 0.25 } } },
        { op: 'get', store: 'books', id: 'D-1' },
    ])
    bothSides(results, (side, list) => {
        const got = list[2].result
        assert.deepEqual(got.notes, [], side + '：replace 应该整条替换掉笔记')
        assert.equal(got.progress.fraction, 0.25, side + '：replace 接受显式替换的进度')
        assert.equal(got.lastOpenedAt, 10, side + '：replace 时 lastOpenedAt 取传入值')
    })
})

// ---------- F1-4：progress.at 参与裁决，缺 at 时行为不变 ----------

test('progress.at 比 lastOpenedAt 更能代表进度新鲜度；任一方缺 at 时退回旧行为', () => {
    const stamp = m => node.progressStamp(m)
    assert.equal(stamp({ lastOpenedAt: 500 }), 500, '没有 at 时只看 lastOpenedAt（向后兼容）')
    assert.equal(stamp({ lastOpenedAt: 500, progress: { at: 800 } }), 800, 'at 更新时以 at 为准')
    assert.equal(stamp({ lastOpenedAt: 900, progress: { at: 800 } }), 900, '取两者最大')
    const py = python('import library_store as ls; print(ls.progress_stamp({"lastOpenedAt":500,"progress":{"at":800}}), ls.progress_stamp({"lastOpenedAt":900}), ls.progress_stamp({"lastOpenedAt":500,"progress":{}}))')
    assert.equal(py, '800 900 500', 'Python 侧同口径：' + py)
    // 缺 at 的陈旧写入仍按 lastOpenedAt 判（旧记录兼容）
    const results = runSequence([
        { op: 'put', store: 'books', id: 'E-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'E-1', lastOpenedAt: 700, progress: { fraction: 0.7 } } },
        { op: 'put', store: 'books', id: 'E-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'E-1', lastOpenedAt: 300, progress: { fraction: 0.3 } } },
        { op: 'get', store: 'books', id: 'E-1' },
    ])
    bothSides(results, (side, list) => {
        assert.equal(list[2].result.progress.fraction, 0.7,
            side + '：双方都没有 at 时按 lastOpenedAt 择新')
    })
})

// ---------- 非书籍存储保持原样（整条覆盖） ----------

test('backgrounds/audio/qq 的 put 保持整条覆盖语义（没有 notes/progress）', () => {
    const results = runSequence([
        { op: 'put', store: 'backgrounds', id: 'F-1', data: 'YQ==', mime: 'image/png',
            meta: { id: 'F-1', name: '旧名字', addedAt: 999 } },
        { op: 'put', store: 'backgrounds', id: 'F-1', data: 'YQ==', mime: 'image/png',
            meta: { id: 'F-1', name: '新名字', addedAt: 1 } },
        { op: 'get', store: 'backgrounds', id: 'F-1' },
    ])
    bothSides(results, (side, list) => {
        assert.equal(list[2].result.name, '新名字', side + '：非书籍存储应整条覆盖')
        assert.equal(list[2].result.addedAt, 1)
    })
})

test('两侧落盘的元数据串逐字节相同（同一序列、同一规则）', () => {
    const dir = scratch('fix1-raw-')
    const steps = [
        { op: 'put', store: 'books', id: 'R-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'R-1', title: '山中的信', lastOpenedAt: 500, progress: { at: 500, fraction: 0.9 },
                notes: [note('keep', 500), tombstone('gone', 300, 400)] } },
        { op: 'meta', store: 'books', id: 'R-1',
            meta: { id: 'R-1', title: '改名', lastOpenedAt: 100, progress: { at: 100, fraction: 0.1 },
                notes: [note('keep', 100), note('gone', 300)] } },
    ]
    const stepsFile = join(dir, 'steps.json')
    writeFileSync(stepsFile, JSON.stringify(steps))
    try {
        const pyRaw = python(`
import json, sys, sqlite3
from pathlib import Path
import library_store as ls
store = ls.LibraryStore(Path(sys.argv[1]), 19297)
for step in json.load(open(sys.argv[2])):
    store.run(step)
print(sqlite3.connect(store.path).execute("SELECT meta FROM records WHERE store='books' AND id='R-1'").fetchone()[0])
`, { argv: [dir, stepsFile] })
        for (const step of steps) node.runStore(step)
        const { DatabaseSync } = require('node:sqlite')
        const db = new DatabaseSync(join(nodeDir, 'library.sqlite3'))
        const nodeRaw = db.prepare("SELECT meta FROM records WHERE store='books' AND id='R-1'").get().meta
        db.close()
        assert.equal(pyRaw, nodeRaw, '同一串操作在两侧写出的 meta 必须逐字节一致')
        assert.match(pyRaw, /山中的信|改名/, '不该被转义成 \\u 形式：' + pyRaw)
    } finally {
        rmSync(dir, { recursive: true, force: true })
        // 清掉这条用例在 Node 库里留下的记录，避免影响别的用例
        node.runStore({ op: 'delete', store: 'books', id: 'R-1' })
    }
})

// ---------- F1-12：存储引擎不再静默降级 ----------

test('SQLite 打不开时显式报错退出，不会改用 JSON 顶替', () => {
    const dir = scratch('fix1-engine-')
    const blocker = join(dir, 'blocked.txt')
    writeFileSync(blocker, 'x')
    // 把 READER_DATA_DIR 指到一个普通文件下面 → SQLite 必然打不开
    const broken = join(blocker, 'library-dir')
    const result = spawnSync(process.execPath, [join(ROOT, 'cloud', 'server.js'), '--port', '19211', '--no-open'], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, READER_DATA_DIR: broken }, timeout: 15000,
    })
    assert.equal(result.status, 1, '应以非 0 退出，实际 status=' + result.status + ' stderr=' + result.stderr)
    assert.match(result.stderr, /无法打开 SQLite 资料库/, '要显式报错：' + result.stderr)
    assert.match(result.stderr, /READER_STORAGE=json/, '要指出改用 JSON 必须显式设置')
    assert.equal(existsSync(join(broken, 'library.json')), false, '不许悄悄写出 JSON 库')
    rmSync(dir, { recursive: true, force: true })
})

test('显式 READER_STORAGE=json 才用 JSON 库，且裁决规则与 SQLite 一致', () => {
    const dir = scratch('fix1-json-')
    const script = 'const s=require(process.argv[1]);process.stdout.write(s.engine)'
    const engine = spawnSync(process.execPath, ['-e', script, join(ROOT, 'cloud', 'server.js')], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, READER_DATA_DIR: dir, READER_STORAGE: 'json' },
    })
    assert.equal(engine.stdout.trim(), 'json', '显式 json 才降级：' + engine.stderr)
    // 同一个陈旧 put 序列在 JSON 引擎上也必须给出相同裁决
    const steps = [
        { op: 'put', store: 'books', id: 'J-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'J-1', lastOpenedAt: 500, progress: { at: 500, fraction: 0.9 }, notes: [note('k', 500)] } },
        { op: 'put', store: 'books', id: 'J-1', data: 'YQ==', mime: 'text/plain',
            meta: { id: 'J-1', lastOpenedAt: 100, progress: { at: 100, fraction: 0.1 }, notes: [] } },
        { op: 'get', store: 'books', id: 'J-1' },
    ]
    const stepsFile = join(dir, 'steps.json')
    writeFileSync(stepsFile, JSON.stringify(steps))
    const runner = `
const path = require('node:path')
process.env.READER_DATA_DIR = ${JSON.stringify(dir)}
process.env.READER_STORAGE = 'json'
const server = require(${JSON.stringify(join(ROOT, 'cloud', 'server.js'))})
const steps = require(${JSON.stringify(stepsFile)})
const out = steps.map(step => { try { return { ok: true, result: server.runStore(step) } } catch (e) { return { ok: false, error: e.message, code: e.code || null } } })
process.stdout.write(JSON.stringify(out))
`
    const jsonResults = JSON.parse(spawnSync(process.execPath, ['-e', runner], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    }).stdout)
    assert.equal(jsonResults[2].result.progress.fraction, 0.9, 'JSON 引擎也要有同样的进度裁决')
    assert.equal(jsonResults[2].result.notes.find(n => n.id === 'k').text, 'k 原文。', 'JSON 引擎也要保留笔记')
    rmSync(dir, { recursive: true, force: true })
})


test('较新的打开时间不能复活旧进度，缺失目录字段不擦除已有目录/PDF映射', () => {
    const fresh = { id: 'TOC-stale', lastOpenedAt: 200, progress: {at:200,percent:0,readMap:{}},
        tocFlat: [{label:'前言',href:'a#start',index:0,depth:0}], pdfPages:[1,1,2], pdfPageCount:2 }
    const stale = { id:'TOC-stale', lastOpenedAt:300, progress:{at:100,percent:.8} }
    const results=runSequence([
        {op:'put',store:'books',id:fresh.id,meta:fresh,data:'YQ==',mime:'text/plain'},
        {op:'meta',store:'books',id:fresh.id,meta:stale},
        {op:'get',store:'books',id:fresh.id},
    ])
    bothSides(results,(side,list)=>{
        const got=list[2].result
        assert.equal(got.progress.percent,0,side)
        assert.deepEqual(got.tocFlat,fresh.tocFlat,side)
        assert.deepEqual(got.pdfPages,[1,1,2],side)
        assert.equal(got.pdfPageCount,2,side)
    })
})
