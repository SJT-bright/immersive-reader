// 无端口、无数据库：执行真实 touchBook 函数与备份解码，验证目录/归零元数据不会回退。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { decodeBackup, blobToBase64, digest } from '../js/backup.js'
import { compareBookProgress } from '../js/db.js'

test('启动合并以双方进度at择新，较新的打开时间不能复活旧位置', () => {
    const reset = { progress: { at: 200 }, lastOpenedAt: 200 }
    const old = { progress: { at: 100 }, lastOpenedAt: 300 }
    assert.ok(compareBookProgress(reset, old) > 0)
    assert.ok(compareBookProgress(old, reset) < 0)
    assert.ok(compareBookProgress({ lastOpenedAt: 300 }, { lastOpenedAt: 200 }) > 0)
})

const dbSource = readFileSync(new URL('../js/db.js', import.meta.url), 'utf8')
const touchSource = dbSource.slice(dbSource.indexOf('export async function touchBook'),
    dbSource.indexOf('// 主页目录：')).replace('export ', '')
assert.match(touchSource, /^async function touchBook/)

function touchHarness (initial, now = 300) {
    let book = structuredClone(initial), writes = 0, mirrors = 0, flushes = 0
    const transaction = {}
    const store = {
        transaction,
        get: () => structuredClone(book),
        put: record => { book = structuredClone(record); writes++ },
    }
    const context = {
        Date: { now: () => now },
        openDB: async () => ({ transaction: () => ({ objectStore: () => store }) }),
        requestAsPromise: async result => result,
        queueMirror: () => { mirrors++ },
        txDone: async () => {},
        flushMirror: async () => { flushes++ },
    }
    vm.createContext(context)
    vm.runInContext(touchSource + ';globalThis.touch = touchBook', context)
    return {
        touch: progress => context.touch('synthetic-book', progress),
        read: () => ({ book, writes, mirrors, flushes }),
    }
}

const toc = [{ label: '第一节', href: 'ch.xhtml#heading', index: 0, depth: 0 }]
const freshBook = progress => ({
    id: 'synthetic-book', title: '合成书', lastOpenedAt: 200, progress,
    tocFlat: toc, notes: [{ id: 'n1', text: '保留笔记' }],
})

test('迟到旧进度不能覆盖归零，也不推进打开时间、journal 或 mirror', async () => {
    const reset = { at: 200, percent: 0, cfi: null, readMap: {} }
    const initial = freshBook(reset), harness = touchHarness(initial)
    await harness.touch({ at: 100, percent: .8, cfi: 'epubcfi(/6/4)', readMap: { 0: [[0, .8]] } })
    assert.deepEqual(harness.read(), { book: initial, writes: 0, mirrors: 0, flushes: 0 })
})

test('较新进度正常保存，并保留独立目录与笔记', async () => {
    const harness = touchHarness(freshBook({ at: 200, percent: .2, readMap: { 0: [[0, .2]] } }))
    const progress = { at: 250, percent: .3, readMap: { 0: [[0, .3]] } }
    await harness.touch(progress)
    const result = harness.read()
    assert.deepEqual(result.book.progress, progress)
    assert.deepEqual(result.book.tocFlat, toc)
    assert.deepEqual(result.book.notes, [{ id: 'n1', text: '保留笔记' }])
    assert.equal(result.book.lastOpenedAt, 300)
    assert.equal(result.writes, 1)
    assert.equal(result.mirrors, 1)
    assert.equal(result.flushes, 1)
})

test('同一时间戳保持后写兼容；缺 at 的旧进度仍可升级保存', async () => {
    for (const [current, incoming] of [
        [{ at: 200, percent: .2 }, { at: 200, percent: .3 }],
        [{ percent: .2 }, { at: 100, percent: .3 }],
        [{ at: 200, percent: .2 }, { percent: .3 }],
    ]) {
        const harness = touchHarness(freshBook(current))
        await harness.touch(incoming)
        assert.deepEqual(harness.read().book.progress, incoming)
        assert.equal(harness.read().writes, 1)
    }
})

test('仅打开书时仍更新访问时间，书不存在时不产生写入', async () => {
    const harness = touchHarness(freshBook({ at: 200, percent: .2 }))
    await harness.touch()
    assert.equal(harness.read().book.lastOpenedAt, 300)
    assert.equal(harness.read().book.progress.percent, .2)
    const missing = touchHarness(undefined)
    await missing.touch({ at: 300, percent: .1 })
    assert.equal(missing.read().writes, 0)
})

async function backupOf (extra = {}) {
    const blob = new Blob(['synthetic-epub-bytes'], { type: 'application/epub+zip' })
    return {
        app: 'immersive-reader', version: 2, settings: {},
        data: { books: [{
            id: 'synthetic-pdf', title: '合成 PDF', author: '', format: 'pdf', addedAt: 1,
            lastOpenedAt: 2, data: await blobToBase64(blob), mime: blob.type,
            byteLength: blob.size, sha256: await digest(blob), tocFlat: toc,
            progress: { at: 200, cfi: null, percent: 0, fraction: 0, readMap: {} },
            ...extra,
        }], backgrounds: [], audio: [] },
    }
}

test('备份恢复的超大派生目录降级为开书重建，保留书籍字节和进度', async () => {
    const payload = await backupOf({ tocFlat: Array.from({ length: 3000 }, (_, index) => ({
        label: '原'.repeat(500), href: `chapter${index}.xhtml`, index, depth: 0,
    })) })
    const book = (await decodeBackup(payload)).data.books[0]
    assert.equal(book.tocFlat, null)
    assert.equal(book.tocCacheOmitted, true)
    assert.equal(await book.data.text(), 'synthetic-epub-bytes')
    assert.equal(book.progress.at, 200)
    assert.equal(book.progress.percent, 0)
})

test('PDF 一页拆多个 section 的原页映射与导入标志在备份恢复后完整保留', async () => {
    const metadata = { pdfPages: [1, 1, 2], pdfPageCount: 2, pdfEmptyPages: 0, pdfTextOnly: true }
    const restored = (await decodeBackup(await backupOf(metadata))).data.books[0]
    for (const [field, value] of Object.entries(metadata)) assert.deepEqual(restored[field], value)
    assert.deepEqual(restored.tocFlat, toc)
    assert.equal(restored.progress.at, 200)
    assert.equal(restored.progress.percent, 0)
})

test('旧 PDF 备份没有映射仍兼容；未知 section 的 null 映射原样保留', async () => {
    const legacy = (await decodeBackup(await backupOf())).data.books[0]
    for (const field of ['pdfPages', 'pdfPageCount', 'pdfEmptyPages', 'pdfTextOnly']) {
        assert.equal(Object.hasOwn(legacy, field), false)
    }
    const restored = (await decodeBackup(await backupOf({ pdfPages: [1, null, 2] }))).data.books[0]
    assert.deepEqual(restored.pdfPages, [1, null, 2])
})

test('非法或过长 PDF 元数据安全降级，不污染 EPUB/TXT 恢复', async () => {
    const broken = (await decodeBackup(await backupOf({
        pdfPages: [1, '2', -1], pdfPageCount: 1501, pdfEmptyPages: -1, pdfTextOnly: 'true',
    }))).data.books[0]
    for (const field of ['pdfPages', 'pdfPageCount', 'pdfEmptyPages', 'pdfTextOnly']) {
        assert.equal(Object.hasOwn(broken, field), false)
    }
    const tooLong = (await decodeBackup(await backupOf({
        pdfPages: Array(0xFFFF - 5).fill(1), pdfPageCount: 1,
    }))).data.books[0]
    assert.equal(Object.hasOwn(tooLong, 'pdfPages'), false)
    const wrongPage = (await decodeBackup(await backupOf({ pdfPageCount: 2, pdfPages: [1, 3] }))).data.books[0]
    assert.equal(Object.hasOwn(wrongPage, 'pdfPages'), false)
    for (const format of ['epub', 'txt']) {
        const normal = (await decodeBackup(await backupOf({ format, pdfPages: [1], pdfPageCount: 1 }))).data.books[0]
        assert.equal(Object.hasOwn(normal, 'pdfPages'), false)
        assert.equal(Object.hasOwn(normal, 'pdfPageCount'), false)
    }
})
