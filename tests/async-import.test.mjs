// 大文件导入的非阻塞改造：协作式切分/组装与一次性版本结果一致、进度回调可观测、
// 分块 base64 与一次性编码逐字节一致。全部纯 Node，不碰浏览器 API。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitChapters, splitChaptersAsync, chaptersToEpubBlob } from '../js/txt2epub.js'
import { blobToBase64Cooperative } from '../js/db.js'

test('协作式切分与同步切分结果一致（多章/单章大文件/空文档）', async () => {
    const multi = [
        '第一章 起点', '',
        '段落一第一行', '段落一第二行', '', '段落二。', '',
        '第二章 转折', '', '新的内容。',
        ...Array(50000).fill('填充行用来跨过 20000 行的分片阈值，其中没有标题。'),
    ].join('\n')
    const single = Array(45000).fill('没有章节标题的长文，验证单章也会分片让步。').join('\n')
    for (const [name, text] of [['多章', multi], ['单章大文件', single], ['空文档', ''], ['一行', '只有一行']]) {
        assert.deepEqual(await splitChaptersAsync(text), splitChapters(text), name)
    }
})

test('切分进度按分片回报，行数口径正确', async () => {
    const events = []
    await splitChaptersAsync(Array(45000).fill('一行内容').join('\n'), {
        slice: 10000,
        onProgress: e => events.push(e),
    })
    assert.deepEqual(events, [
        { lines: 10000, totalLines: 45000 },
        { lines: 20000, totalLines: 45000 },
        { lines: 30000, totalLines: 45000 },
        { lines: 40000, totalLines: 45000 },
    ])
})

test('协作式组装的 EPUB 与同步版体积一致、内容可检索、阶段进度齐备', async () => {
    const chapters = [
        { title: '甲', paragraphs: ['第一段。', '第二段。'] },
        { title: '乙', paragraphs: ['内容。'] },
    ]
    const a = await chaptersToEpubBlob(chapters, '书名', '作者')
    const stages = []
    const b = await chaptersToEpubBlob(chapters, '书名', '作者', { cooperative: true, onProgress: e => stages.push(e.stage) })
    assert.equal(a.size, b.size, '两版 zip 体积必须一致')
    const ta = Buffer.from(await a.arrayBuffer()).toString('latin1')
    const tb = Buffer.from(await b.arrayBuffer()).toString('latin1')
    // zip 内是 UTF-8 字节：按「标记的 UTF-8 字节序列（以 latin1 呈现）」做字节级检索
    const asLatin1Bytes = s => Buffer.from(s, 'utf8').toString('latin1')
    for (const marker of ['application/epub+zip', '第一段。', '内容。']) {
        const needle = asLatin1Bytes(marker)
        assert.ok(ta.includes(needle) && tb.includes(needle), `缺少内容：${marker}`)
    }
    assert.ok(stages.includes('章节排版'), '缺少章节排版阶段')
    assert.ok(stages.includes('打包 EPUB'), '缺少打包阶段')
})

test('分块 base64 与一次性编码逐字节一致（含非整块结尾与空 Blob）', async () => {
    for (const size of [0, 1, 2, 3, 49151, 49152, 49153, 100000]) {
        const bytes = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xFF)
        const blob = new Blob([bytes])
        assert.equal(
            await blobToBase64Cooperative(blob),
            Buffer.from(bytes).toString('base64'),
            `size=${size}`,
        )
    }
})
