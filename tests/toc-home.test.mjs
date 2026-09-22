// v1.9.3 主页目录：tocFlat 白名单校验（backup.normalizeTocFlat）与备份往返。
// 主页面板渲染与进度归零的行为验证在 .preview/ E2E 中完成（依赖 IndexedDB 与真实书源）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTocFlat, decodeBackup, blobToBase64, digest } from '../js/backup.js'
import { normalizeSettings } from '../js/settings.js'

test('normalizeTocFlat rejects non-list input and empty results as null', () => {
    assert.equal(normalizeTocFlat(null), null)
    assert.equal(normalizeTocFlat(undefined), null)
    assert.equal(normalizeTocFlat('x'), null)
    assert.equal(normalizeTocFlat([]), null)
    assert.equal(normalizeTocFlat([null, 42, {}]), null) // 全部无效条目同样归 null
})

test('normalizeTocFlat keeps valid entries and repairs bad fields', () => {
    const out = normalizeTocFlat([
        { label: '第一章', href: 'ch1.xhtml', index: 0, depth: 0 },
        { label: '第二章', href: 'ch2.xhtml', index: 3.5, depth: 9 }, // 非整数 index / 超界 depth
        { href: 'ch3.xhtml', index: 2 }, // 缺 label
        { label: '第四章' }, // 缺 href
    ])
    assert.deepEqual(out, [
        { label: '第一章', href: 'ch1.xhtml', index: 0, depth: 0 },
        { label: '第二章', href: 'ch2.xhtml', index: -1, depth: 6 },
        { label: '', href: 'ch3.xhtml', index: 2, depth: 0 },
        { label: '第四章', href: '', index: -1, depth: 0 },
    ])
})

test('tocFlat survives a backup round trip; legacy backups decode it as null', async () => {
    const mk = async withToc => {
        const blob = new Blob(['book-bytes'], { type: 'application/epub+zip' })
        const book = {
            id: 'book-toc', title: '目录书', author: '', format: 'epub',
            lastOpenedAt: 1, progress: { percent: 0.5, readMap: { 0: [[0, 1]] } },
            data: await blobToBase64(blob), mime: blob.type, byteLength: blob.size, sha256: await digest(blob),
            ...(withToc ? { tocFlat: [{ label: '第一章', href: 'ch1.xhtml', index: 0, depth: 0 }] } : {}),
        }
        return { app: 'immersive-reader', version: 2, settings: normalizeSettings(null),
            data: { books: [book], backgrounds: [], audio: [] } }
    }
    const decoded = await decodeBackup(await mk(true))
    assert.deepEqual(decoded.data.books[0].tocFlat,
        [{ label: '第一章', href: 'ch1.xhtml', index: 0, depth: 0 }])
    const legacy = await decodeBackup(await mk(false))
    assert.equal(legacy.data.books[0].tocFlat, null)
})
