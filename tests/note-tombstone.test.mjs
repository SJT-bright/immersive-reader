// 笔记删除标记（墓碑）与时间戳合并的专项测试。
// 覆盖缺陷：磁盘镜像失败期间删掉一条笔记，另一窗口 / 重载时按 id 取并集把它复活。
// 同时守住既有行为：镜像失败期间另一侧新写的笔记不能丢。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeNotes } from '../js/db.js'
import { decodeBackup, blobToBase64, digest } from '../js/backup.js'
import {
    isDeletedNote, noteStamp, liveNotes, makeNoteTombstone, noteCounts, normalizeNote,
} from '../js/notes.js'

const quote = (id, editedAt, extra = {}) => ({
    id, type: 'quote', cfi: `epubcfi(/6/2!/4/2/${id})`, text: `${id} 原文。`, after: '下一句。',
    comment: '心得', chapter: '第一章', page: '3', location: '3',
    createdAt: editedAt - 10, editedAt, ...extra,
})

// ---------- 合并裁决 ----------

test('镜像失败期间的删除不会被磁盘旧副本复活', () => {
    const deletedAt = 2000
    const local = [makeNoteTombstone(quote('x', 1000), deletedAt)]
    const disk = [quote('x', 1000)] // 磁盘还是删除前的快照
    const merged = mergeNotes(local, disk)
    assert.deepEqual(merged.map(n => n.id), ['x'])
    assert.ok(isDeletedNote(merged[0]), '同 id 只剩删除标记')
    assert.equal(liveNotes(merged).length, 0, '界面读取看不到复活的笔记')
})

test('磁盘较新时用磁盘上的删除标记压住本地活副本', () => {
    const marker = makeNoteTombstone(quote('x', 1000), 2000)
    const merged = mergeNotes([quote('x', 1000)], [marker, quote('y', 500)])
    assert.ok(merged.find(n => n.id === 'x').deletedAt, '本地旧副本被磁盘标记压住')
    assert.equal(merged.find(n => n.id === 'y').text, 'y 原文。')
})

test('删除只压住这一条，另一侧未删除的新笔记不丢', () => {
    const marker = makeNoteTombstone(quote('x', 1000), 3000)
    const local = [marker, quote('mine', 2500)] // 镜像失败期间本地新写的心得
    const disk = [quote('x', 1000), quote('theirs', 2600)] // 另一窗口补同步上来的笔记
    const merged = mergeNotes(local, disk)
    const live = liveNotes(merged).map(n => n.id).sort()
    assert.deepEqual(live, ['mine', 'theirs'], '两条活笔记都在，被删的那条不复活')
})

test('删除之后的编辑按最后写入胜出，撤销删除能赢回标记', () => {
    const marker = makeNoteTombstone(quote('x', 1000), 2000)
    const editedAfterDelete = quote('x', 2500, { comment: '删完之后又改了' })
    assert.equal(mergeNotes([editedAfterDelete], [marker])[0].comment, '删完之后又改了')
    assert.equal(mergeNotes([marker], [editedAfterDelete])[0].comment, '删完之后又改了')
})

test('时间戳相同的平局判给删除', () => {
    const same = 5000
    const marker = makeNoteTombstone(quote('x', same), same)
    assert.equal(marker.deletedAt, same)
    assert.ok(isDeletedNote(mergeNotes([marker], [quote('x', same)])[0]), '本地标记胜磁盘同时间编辑')
    assert.ok(isDeletedNote(mergeNotes([quote('x', same)], [marker])[0]), '磁盘标记胜本地同时间编辑')
})

test('没有标记的旧数据合并行为不变（较新者胜、平手保本地）', () => {
    const older = quote('x', 1000, { comment: '旧' })
    const newer = quote('x', 2000, { comment: '新' })
    assert.equal(mergeNotes([newer], [older])[0].comment, '新')
    assert.equal(mergeNotes([older], [newer])[0].comment, '新')
    const a = { ...quote('x', 1000), comment: '本地' }
    const b = { ...quote('x', 1000), comment: '磁盘' }
    assert.equal(mergeNotes([a], [b])[0].comment, '本地', '无标记同时间仍保本地')
})

test('脏输入不炸：非数组、缺 id、null 条目', () => {
    assert.deepEqual(mergeNotes(null, undefined), [])
    assert.deepEqual(mergeNotes([{ id: '' }, null, quote('ok', 10)], ['x', 42]), [quote('ok', 10)])
    assert.deepEqual(liveNotes(null), [])
    assert.deepEqual(noteCounts([null, makeNoteTombstone(quote('x', 1), 9)]), { quotes: 0, bookmarks: 0, total: 0 })
})

// ---------- 标记本体与界面过滤 ----------

test('删除标记保留锚点、丢掉正文与心得，时间戳不早于原条目', () => {
    const source = quote('x', 1000)
    const marker = makeNoteTombstone(source, 1500)
    assert.deepEqual(
        { id: marker.id, type: marker.type, cfi: marker.cfi },
        { id: 'x', type: 'quote', cfi: source.cfi }, '服务端锚点校验仍过得去')
    assert.equal(marker.deletedAt, 1500)
    assert.equal(noteStamp(marker), 1500, '裁决时间取 deletedAt 而不是 editedAt')
    for (const field of ['text', 'after', 'comment', 'chapter', 'page', 'location']) {
        assert.equal(marker[field], '', `${field} 不留残文`)
    }
})

test('标记时间戳被抬到不低于被删条目，避免同刻删除输给原编辑', () => {
    const source = quote('x', 1000)
    assert.equal(makeNoteTombstone(source, 900).deletedAt, 1000)
})

test('标记没有合法 epubcfi 时补占位锚点，备份解码不会整包报错', () => {
    const marker = makeNoteTombstone({ id: 'x', type: 'quote', cfi: 'javascript:bad', editedAt: 7 }, 8)
    assert.ok(marker.cfi.startsWith('epubcfi('))
    assert.ok(normalizeNote(marker), '标记可被规范化')
})

test('noteCounts 与 liveNotes 过滤标记，划线/书签计数如实', () => {
    const notes = [quote('a', 100), quote('b', 200), makeNoteTombstone(quote('c', 300), 400),
        { id: 'd', type: 'bookmark', cfi: 'epubcfi(/6/4)', text: '书签', createdAt: 100, editedAt: 100 }]
    assert.deepEqual(noteCounts(notes), { quotes: 2, bookmarks: 1, total: 3 })
    assert.deepEqual(liveNotes(notes).map(n => n.id), ['a', 'b', 'd'])
})

// ---------- 备份契约 ----------

function backupPayload (notes) {
    const data = new Blob(['dummy-epub-bytes'], { type: 'application/epub+zip' })
    return (async () => {
        const b64 = await blobToBase64(data)
        return {
            app: 'immersive-reader', version: 2, exportedAt: new Date().toISOString(),
            settings: {},
            data: {
                books: [{
                    id: 'book-1', title: '测试书', author: '', format: 'epub',
                    data: b64, mime: data.type, byteLength: data.size, sha256: await digest(data),
                    addedAt: 1, lastOpenedAt: 1, notes,
                }],
                backgrounds: [], audio: [],
            },
        }
    })()
}

test('带标记的备份解码后保留标记，不报「笔记或书签格式损坏」', async () => {
    const live = quote('x', 1000)
    const marker = makeNoteTombstone(live, 2000)
    const decoded = await decodeBackup(await backupPayload([live, marker]))
    const notes = decoded.data.books[0].notes
    assert.equal(notes.length, 2, '标记不被整包拒绝')
    assert.ok(notes.some(n => n.deletedAt === 2000), '标记随备份留存，防止旧副本复活')
    assert.deepEqual(liveNotes(notes).map(n => n.id), ['x'], '恢复后界面仍只显示那条活笔记')
})

test('没有标记的旧备份解码结果逐键不变', async () => {
    const raw = {
        id: 'note-1', type: 'quote', cfi: 'epubcfi(/6/2!/4/2/1:0)', text: '测试摘录', after: '下一句。',
        comment: '自己的想法', chapter: '第一章', page: '3', location: '', createdAt: 1,
    }
    const decoded = await decodeBackup(await backupPayload([raw]))
    assert.deepEqual(decoded.data.books[0].notes, [{ ...raw, editedAt: raw.createdAt }])
    assert.ok(!('deletedAt' in decoded.data.books[0].notes[0]), '旧记录不凭空多出标记键')
})

test('normalizeNote 只在条目真带标记时输出 deletedAt', () => {
    assert.ok(!('deletedAt' in normalizeNote(quote('x', 1000))))
    assert.ok(!('deletedAt' in normalizeNote({ ...quote('x', 1000), deletedAt: 0 })))
    assert.ok(!('deletedAt' in normalizeNote({ ...quote('x', 1000), deletedAt: 'nope' })))
    assert.equal(normalizeNote({ ...quote('x', 1000), deletedAt: 4321 }).deletedAt, 4321)
})
