// PDF 段落重排单元测试：窄列断词合并、行距/缩进/不满行分段、英文拼接。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleRows, rowsToParas, reflowTextLines } from '../js/reflow.js'

// 造一条 pdf.js 的 text item。中文按一字一宽近似，两端对齐的满行手动给 w。
function item(text, y, { x = 40, w = null, h = 12, eol = true } = {}) {
    return { str: text, transform: [1, 0, 0, 1, x, y], width: w ?? text.length * h, height: h, hasEOL: eol }
}

// 造一条已聚合的物理行（直接喂 rowsToParas）。
function row(text, y, { x0 = 40, x1 = 390, h = 12 } = {}) {
    return { text, y, x0, x1, h }
}

test('窄列硬换行合并成段（原书「基/础定律」断词场景）', () => {
    // 窄列排版：每行都顶满列宽（x1≈390），词语被硬拆到两行。
    const items = [
        item('将事物拆解至最基本的原理。首先问自己：', 700, { w: 350 }),
        item('我最确信为真的基', 684, { w: 348 }),
        item('础定律有哪些?将这些定律确立为公理，以此', 668, { w: 350 }),
        item('为基础展开推理，然', 652, { w: 349 }),
        item('后再用这些公理来检验你的结论。', 636, { w: 245 }),
    ]
    const paras = rowsToParas(assembleRows(items))
    assert.deepEqual(paras, [
        '将事物拆解至最基本的原理。首先问自己：我最确信为真的基础定律有哪些?将这些定律确立为公理，以此为基础展开推理，然后再用这些公理来检验你的结论。',
    ])
})

test('段间空隙（行距骤增）分段', () => {
    const rows = [
        row('第一段第一句，', 700),
        row('第二句收尾。', 684, { x1: 250 }),
        row('第二段开头一句。', 646),   // 行距 38 > 行高 12 的 1.5 倍
    ]
    assert.deepEqual(rowsToParas(rows), [
        '第一段第一句，第二句收尾。',
        '第二段开头一句。',
    ])
})

test('中文首行缩进两字开新段', () => {
    const rows = [
        row('这一段继续讲到行尾还没讲完就换', 700),
        row('行结束本段', 684, { x1: 250 }),
        row('新段首行缩进两字开始', 668, { x0: 64 }),   // x0 缩进 24 > 阈值
    ]
    assert.deepEqual(rowsToParas(rows), [
        '这一段继续讲到行尾还没讲完就换行结束本段',
        '新段首行缩进两字开始',
    ])
})

test('满行行尾句号保守分段（宁分勿粘）', () => {
    const rows = [
        row('这句话恰好顶满行尾以句号结束。', 700),
        row('下一句从新行继续讲述。', 684, { x1: 388 }),
    ]
    assert.deepEqual(rowsToParas(rows), [
        '这句话恰好顶满行尾以句号结束。',
        '下一句从新行继续讲述。',
    ])
})

test('英文跨行补空格、连字符断词复原', () => {
    assert.deepEqual(rowsToParas([
        row('Reading is a kind of', 700),
        row('deep focus.', 684, { x1: 200 }),
    ]), ['Reading is a kind of deep focus.'])
    assert.deepEqual(rowsToParas([
        row('We follow the princi-', 700),
        row('ple of reflow.', 684, { x1: 180 }),
    ]), ['We follow the principle of reflow.'])
})

test('assembleRows 把同一物理行的多个 item 聚成一行', () => {
    const items = [
        { str: '第一性原理', transform: [1, 0, 0, 1, 40, 700], width: 48, height: 12, hasEOL: false },
        { str: '是一种', transform: [1, 0, 0, 1, 88, 700], width: 36, height: 12, hasEOL: false },
        { str: '思维方式。', transform: [1, 0, 0, 1, 124, 700], width: 60, height: 12, hasEOL: true },
        { str: '第二行', transform: [1, 0, 0, 1, 40, 684], width: 36, height: 12, hasEOL: true },
    ]
    const rows = assembleRows(items)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].text, '第一性原理是一种思维方式。')
    assert.equal(rows[0].x0, 40)
    assert.equal(rows[0].x1, 184)
    assert.equal(rows[1].text, '第二行')
})

test('assembleRows 英文 item 之间补空格', () => {
    const items = [
        { str: 'The', transform: [1, 0, 0, 1, 40, 700], width: 22, height: 12, hasEOL: false },
        { str: 'first', transform: [1, 0, 0, 1, 66, 700], width: 26, height: 12, hasEOL: false },
        { str: 'principle', transform: [1, 0, 0, 1, 96, 700], width: 50, height: 12, hasEOL: true },
    ]
    assert.equal(assembleRows(items)[0].text, 'The first principle')
})

test('纯文本兜底：无几何信息按标点合并', () => {
    assert.deepEqual(reflowTextLines([
        '将事物拆解至最基本的',
        '原理，首先问自己：',
        '我最确信为真的基础定律。',
    ]), ['将事物拆解至最基本的原理，首先问自己：我最确信为真的基础定律。'])
    assert.deepEqual(reflowTextLines(['第一句。', '第二句。']), ['第一句。', '第二句。'])
})

test('空输入安全', () => {
    assert.deepEqual(assembleRows([]), [])
    assert.deepEqual(rowsToParas([]), [])
    assert.deepEqual(reflowTextLines([]), [])
})
