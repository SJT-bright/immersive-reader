// 删除标记在磁盘镜像里的契约检查（两个服务端实现都要过）：
//   Node  cloud/server.js             —— start.sh / 桌面 APP / 便携包实际用的服务
//   Python scripts/library_store.py   —— scripts/serve.py 的同名实现（直接跑类，不占端口）
// 运行：node tests/note-tombstone-store-check.mjs
// 结论要点：删除标记要能落盘、要能在旧窗口的元数据写入中存活；remove=true 的既有
// 「整条抹掉」语义保持不变（tests/shared-library-check.* 钉住了它），所以客户端删除
// 走「把墓碑当最新版本 upsert」，不改服务端。
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const liveNote = (id, editedAt) => ({
    id, type: 'quote', cfi: `epubcfi(/6/2!/4/2/${id})`, text: `${id} 原文。`,
    comment: '心得', createdAt: editedAt - 5, editedAt,
})
const markerOf = (id, editedAt, deletedAt) => ({
    ...liveNote(id, editedAt), text: '', comment: '', editedAt: deletedAt, deletedAt,
})

// 空闲端口：本机 191xx 常有别的会话的服务在跑，固定端口会被「同工作区则复用」的逻辑吞掉
async function freePort () {
    return new Promise((res, rej) => {
        const srv = net.createServer()
        srv.once('error', rej)
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port
            srv.close(() => res(port))
        })
    })
}

// 共享资料库的删除标记契约，call(body) 抽象掉具体传输方式
async function checkContract (call, label) {
    const common = { store: 'books', id: 'tombstone-book' }
    await call({
        ...common, op: 'put', data: 'YQ==', mime: 'text/plain',
        meta: { id: 'tombstone-book', lastOpenedAt: 1, notes: [liveNote('x', 1000), liveNote('y', 1100)] },
    })

    // 删除＝把墓碑作为这条笔记的最新版本 upsert（不带 remove，remove 的旧语义留给旧客户端）
    await call({ ...common, op: 'note', note: markerOf('x', 1000, 2000) })
    let saved = (await call({ ...common, op: 'get' })).notes
    assert.deepEqual(saved.map(n => n.id).sort(), ['x', 'y'], `${label}：删一条不影响另一条`)
    assert.equal(saved.find(n => n.id === 'x').deletedAt, 2000, `${label}：磁盘镜像保留删除标记`)
    assert.equal(saved.find(n => n.id === 'y').text, 'y 原文。', `${label}：未删笔记的内容不变`)

    // 另一窗口迟到的阅读位置写入（meta op）不得抹掉磁盘上的标记
    await call({
        ...common, op: 'meta',
        meta: { id: 'tombstone-book', lastOpenedAt: 9999, notes: [liveNote('x', 1000)], progress: { fraction: 0.4 } },
    })
    const afterMeta = await call({ ...common, op: 'get' })
    assert.equal(afterMeta.notes.find(n => n.id === 'x').deletedAt, 2000, `${label}：旧副本的元数据写入压不掉磁盘标记`)
    assert.equal(afterMeta.progress.fraction, 0.4, `${label}：阅读位置照常更新`)

    // list 是启动合并读的那一份，同样必须带标记
    const listed = (await call({ op: 'list' })).records.find(r => r.id === 'tombstone-book')
    assert.equal(listed.notes.find(n => n.id === 'x').deletedAt, 2000, `${label}：list 返回的元数据含标记`)

    // 标记之后同 id 再写活笔记（撤销删除 / 删后又改）＝按到达顺序覆盖标记
    await call({ ...common, op: 'note', note: liveNote('x', 3000) })
    saved = (await call({ ...common, op: 'get' })).notes
    assert.ok(!saved.find(n => n.id === 'x').deletedAt, `${label}：较新的活笔记覆盖标记`)

    // 既有语义不能被破坏：remove=true 仍是整条抹掉（tests/shared-library-check.* 依赖）
    await call({ ...common, op: 'note', note: liveNote('y', 1100), remove: true })
    saved = (await call({ ...common, op: 'get' })).notes
    assert.deepEqual(saved.map(n => n.id), ['x'], `${label}：remove=true 仍无标记地删除`)
}

async function checkNode () {
    const port = await freePort()
    const dir = await mkdtemp(join(ROOT, '.preview', 'tombstone-store-'))
    const base = `http://127.0.0.1:${port}`
    const child = spawn(process.execPath, [join(ROOT, 'cloud', 'server.js'), '--no-open'], {
        env: { ...process.env, READER_LOCAL: '1', READER_NO_OPEN: '1', PORT: String(port), READER_DATA_DIR: dir },
        stdio: 'ignore',
    })
    let exited = null
    child.once('exit', code => { exited = code })
    try {
        let health = null
        for (let i = 0; i < 60 && !health; i++) {
            if (exited !== null) throw new Error(`Node 服务提前退出 code=${exited}`)
            try { health = await (await fetch(base + '/_reader/health')).json() } catch { /* 等待启动 */ }
            if (!health) await new Promise(r => setTimeout(r, 100))
        }
        // 确认打到的是本脚本刚起的实例：cloud/server.js 本机模式报 mode=local
        assert.equal(health?.app, 'immersive-reader', 'Node 服务健康检查失败')
        assert.equal(health?.mode, 'local', `端口 ${port} 上不是 Node 本机服务：${JSON.stringify(health)}`)
        await checkContract(async (body) => {
            // 本机模式校验同源：Origin 必须等于服务绑定地址
            const res = await fetch(base + '/_reader/library', {
                method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body),
            })
            const data = await res.json()
            assert.equal(res.status, 200, `${body.op} 失败：${data.error}`)
            return data
        }, 'Node cloud/server.js')
        console.log('Node cloud/server.js：删除标记落盘、抗旧副本覆盖、list 带标记、remove 语义不变 通过')
    } finally {
        if (exited === null) child.kill()
        for (let i = 0; i < 30 && exited === null; i++) await new Promise(r => setTimeout(r, 100))
        await rm(dir, { recursive: true, force: true })
    }
}

const PY_SCRIPT = `
import sys
from pathlib import Path
sys.path.insert(0, 'scripts')
from library_store import LibraryStore
store = LibraryStore(Path(sys.argv[1]), 19162)
book = 'tombstone-book'
live = lambda i, t: {'id': i, 'type': 'quote', 'cfi': 'epubcfi(/6/2!/4/2/%s)' % i, 'text': i + ' 原文。',
                     'comment': '心得', 'createdAt': t - 5, 'editedAt': t}
marker = lambda i, t, d: dict(live(i, t), text='', comment='', editedAt=d, deletedAt=d)
common = {'store': 'books', 'id': book}
call = store.run
call(dict(common, op='put', data='YQ==', mime='text/plain',
          meta={'id': book, 'lastOpenedAt': 1, 'notes': [live('x', 1000), live('y', 1100)]}))
call(dict(common, op='note', note=marker('x', 1000, 2000)))
notes = call(dict(common, op='get'))['notes']
assert sorted(n['id'] for n in notes) == ['x', 'y']
assert next(n for n in notes if n['id'] == 'x')['deletedAt'] == 2000, '磁盘镜像保留删除标记'
assert next(n for n in notes if n['id'] == 'y')['text'] == 'y 原文。'
call(dict(common, op='meta', meta={'id': book, 'lastOpenedAt': 9999, 'notes': [live('x', 1000)],
                                   'progress': {'fraction': 0.4}}))
got = call(dict(common, op='get'))
assert next(n for n in got['notes'] if n['id'] == 'x')['deletedAt'] == 2000, '旧副本的元数据写入压不掉磁盘标记'
assert got['progress']['fraction'] == 0.4
listed = next(r for r in call({'op': 'list'})['records'] if r['id'] == book)
assert next(n for n in listed['notes'] if n['id'] == 'x')['deletedAt'] == 2000, 'list 返回的元数据含标记'
call(dict(common, op='note', note=live('x', 3000)))
assert not next(n for n in call(dict(common, op='get'))['notes'] if n['id'] == 'x').get('deletedAt'), '较新的活笔记覆盖标记'
call(dict(common, op='note', note=live('y', 1100), remove=True))
assert [n['id'] for n in call(dict(common, op='get'))['notes']] == ['x'], 'remove=True 仍无标记地删除'
print('ok')
`

async function checkPython () {
    const dir = await mkdtemp(join(ROOT, '.preview', 'tombstone-store-py-'))
    try {
        await new Promise((res, rej) => {
            const child = spawn('python3', ['-c', PY_SCRIPT, dir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
            let out = '', err = ''
            child.stdout.on('data', d => { out += d })
            child.stderr.on('data', d => { err += d })
            child.once('exit', code => {
                if (code === 0 && out.trim().endsWith('ok')) res()
                else rej(new Error(`Python 检查失败 code=${code} ${err || out}`))
            })
        })
        console.log('Python scripts/library_store.py：删除标记落盘、抗旧副本覆盖、list 带标记、remove 语义不变 通过')
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

await checkNode()
await checkPython()
