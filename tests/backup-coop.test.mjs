// 备份模块的非阻塞改造：协作式 base64 解码与同步版逐字节一致；
// decodeBackup 在 Node 可用 WebCrypto 下完成完整校验路径并回报进度。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { base64ToBlob, base64ToBlobCooperative, decodeBackup } from '../js/backup.js'

async function blobBytes (blob) {
    return Buffer.from(await blob.arrayBuffer())
}

test('协作式 base64 解码与同步版逐字节一致（含 1/2/3 字节余数的结尾）', async () => {
    for (const size of [0, 1, 2, 3, 49151, 49152, 49153, 100000]) {
        const bytes = new Uint8Array(size).map((_, i) => (i * 131 + 17) & 0xFF)
        const b64 = Buffer.from(bytes).toString('base64')
        const syncBlob = base64ToBlob(b64)
        const coopBlob = await base64ToBlobCooperative(b64)
        assert.deepEqual(await blobBytes(coopBlob), await blobBytes(syncBlob), `size=${size}`)
        assert.equal(coopBlob.size, size, `size=${size}`)
    }
})

test('decodeBackup：合成备份完整走通校验、解码与进度回报', async () => {
    const content = Buffer.from('第一段正文。第二段正文。'.repeat(50), 'utf8')
    const b64 = content.toString('base64')
    const sha256 = createHash('sha256').update(content).digest('hex')
    const payload = {
        app: 'immersive-reader',
        version: 2,
        exportedAt: new Date().toISOString(),
        settings: {},
        data: {
            books: [{
                id: 'book_a', data: b64, mime: 'application/epub+zip',
                byteLength: content.length, sha256,
                format: 'txt', title: '测试书', author: '作者',
                addedAt: 1700000000000, lastOpenedAt: 0, progress: null,
                notes: [{ id: 'n1', type: 'bookmark', cfi: 'epubcfi(/6/2)', text: '', createdAt: 1700000001000 }],
            }],
            backgrounds: [], audio: [],
            qqTracks: [],
        },
    }
    const events = []
    const decoded = await decodeBackup(payload, { onProgress: e => events.push(e) })
    assert.equal(decoded.data.books.length, 1)
    const rec = decoded.data.books[0]
    assert.deepEqual(await blobBytes(rec.data), content)
    assert.equal(rec.title, '测试书')
    assert.equal(rec.notes.length, 1)
    assert.deepEqual(events.at(-1), { stage: '读取', done: 1, total: 1 })

    // 内容被篡改 → SHA-256 校验拦截，且不产出半成品
    const tampered = structuredClone(payload)
    tampered.data.books[0].data = Buffer.from('被篡改的内容'.repeat(10), 'utf8').toString('base64')
    await assert.rejects(() => decodeBackup(tampered), /校验失败/)
})
