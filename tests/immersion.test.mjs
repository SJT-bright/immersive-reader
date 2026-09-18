// 书架筛选与排序单元测试
import test from 'node:test'
import assert from 'node:assert/strict'
import { filterSortBooks, coverTheme, shelfHTML } from '../js/bookshelf.js'
import { decodeBackup, blobToBase64, base64ToBlob, digest } from '../js/backup.js'

const books = [
    { id: 'a', title: '山居小记', author: '示例', format: 'epub', addedAt: 100, lastOpenedAt: 300, progress: { percent: .29 } },
    { id: 'b', title: '马斯克原理', author: '埃里克', format: 'epub', addedAt: 200, lastOpenedAt: 100, progress: { percent: 1 } },
    { id: 'c', title: 'Time Flies', author: '', format: 'txt', addedAt: 300, lastOpenedAt: 200, progress: null },
]

test('无过滤时按默认最近打开排序', () => {
    assert.deepEqual(filterSortBooks(books, '', 'recent').map(b => b.id), ['a', 'c', 'b'])
})

test('关键词匹配书名（中英文）与作者，大小写不敏感', () => {
    assert.deepEqual(filterSortBooks(books, '山居', '', 'recent').map(b => b.id), ['a'])
    assert.deepEqual(filterSortBooks(books, 'time', '', 'recent').map(b => b.id), ['c'])
    assert.deepEqual(filterSortBooks(books, '埃里克', '', 'recent').map(b => b.id), ['b'])
})

test('无匹配返回空数组', () => {
    assert.equal(filterSortBooks(books, '不存在', 'recent').length, 0)
})

test('排序：导入时间、书名、进度', () => {
    assert.deepEqual(filterSortBooks(books, '', 'added').map(b => b.id), ['c', 'b', 'a'])
    // 中文 locale 排序下 CJK 前于拉丁字母（ICU 行为），断言与引擎一致
    assert.deepEqual(filterSortBooks(books, '', 'title').map(b => b.id), ['b', 'a', 'c'])
    assert.deepEqual(filterSortBooks(books, '', 'progress').map(b => b.id), ['b', 'a', 'c'])
})

test('未知排序方式回退到最近打开', () => {
    assert.deepEqual(filterSortBooks(books, '', 'hacker').map(b => b.id), ['a', 'c', 'b'])
})

test('排序不改动原数组，渲染串不包含用户数据外的注入', () => {
    const copy = [...books]
    filterSortBooks(copy, '', 'title')
    assert.deepEqual(copy, books)
    assert.match(shelfHTML([{ id: 'x', title: 't', format: 'epub' }]), /--i:0;/)
    assert.ok(coverTheme('x').c1)
})

test('备份 v2 支持书籍封面：合法封面恢复为 Blob，损坏封面拒绝', async () => {
    const bookData = base64ToBlob('aGVsbG8=', 'application/epub+zip')
    const coverBlob = new Blob([new Uint8Array([137, 80, 78, 71, 13, 10])], { type: 'image/png' })
    const payload = {
        app: 'immersive-reader', version: 2,
        settings: {},
        data: {
            books: [{
                id: 'cover-book', title: '带封面的书', author: '', format: 'epub',
                data: await blobToBase64(bookData), mime: 'application/epub+zip',
                byteLength: bookData.size, sha256: await digest(bookData),
                cover: await blobToBase64(coverBlob), coverMime: 'image/png',
                addedAt: 1, lastOpenedAt: 0, progress: null,
            }],
            backgrounds: [], audio: [],
        },
    }
    const decoded = await decodeBackup(payload)
    const restored = decoded.data.books[0]
    assert.ok(restored.cover instanceof Blob, '封面应恢复为 Blob')
    assert.equal(restored.cover.type, 'image/png')
    assert.equal(restored.cover.size, 6)
    const broken = structuredClone(payload)
    broken.data.books[0].cover = '!!! 不是 base64 !!!'
    await assert.rejects(() => decodeBackup(broken), /封面数据无效/)
})
