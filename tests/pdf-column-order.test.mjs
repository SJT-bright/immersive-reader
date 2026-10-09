// PDF 双流并排页的阅读顺序重建（splitColumnFlows）：左列正文、右列编号短标题
// 逐行基线对齐的版式，旧管线按 Y 归行会串成「办哪27.怀孕和生产些证？」。
// 这里断言拆分后的段落顺序与内容，以及单栏页绝不被误拆。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleRows, rowsToParas, splitColumnFlows } from '../js/reflow.js'

// 造一条 pdf.js 的 text item（坐标即 transform[4]=x、transform[5]=y）
function item(str, x, y, width, h = 12) {
    return { str, transform: [1, 0, 0, 1, x, y], width, height: h }
}

// 「人生清单」式页面：左列完整问句（两行一条），右列编号短标题与问句首行同基线。
// 内容取自用户截图的真实串行案例。
function interleavedItems() {
    const rows = [
        { left: '亲人确诊、要生了，什么时候做什么，出院前要办哪', right: '27.怀孕和生产' },
        { left: '些证？' },
        { left: '想减肥、想变好看、想矫正牙齿，哪些做法会把身', right: '28.别为了外形把身体搞坏' },
        { left: '体搞坏？' },
        { left: '亲人走了、被裁了、拿到重病诊断，头几个月最要', right: '29.遭遇重大打击之后' },
        { left: '紧的是什么？' },
        { left: '孩子上学以后，哪些身体和心理的事不能等到考完', right: '30.上学以后的孩子' },
        { left: '再说？' },
        { left: '十八岁之后除了读书和打工还有哪几条路，各自的', right: '31.十八岁之后有哪几条路' },
        { left: '门槛是什么？' },
    ]
    const items = []
    let y = 800
    for (const r of rows) {
        items.push(item(r.left, 40, y, r.left.length * 12))
        if (r.right) items.push(item(r.right, 420, y, r.right.length * 12))
        y -= 20
    }
    return items
}

test('双流并排页：右列标题不再插进左列句子中间', () => {
    const rows = splitColumnFlows(assembleRows(interleavedItems()))
    const paras = rowsToParas(rows)
    const joined = paras.join('\n')
    // 旧管线会出现的串行片段，一个都不允许出现
    for (const bad of ['办哪27', '把身28', '最要29', '考完30', '的31']) {
        assert.ok(!joined.includes(bad), `仍串行：${bad} 出现在段落里`)
    }
    // 左列问句各自完整成段
    assert.ok(paras.includes('亲人确诊、要生了，什么时候做什么，出院前要办哪些证？'))
    assert.ok(paras.includes('想减肥、想变好看、想矫正牙齿，哪些做法会把身体搞坏？'))
    assert.ok(paras.includes('十八岁之后除了读书和打工还有哪几条路，各自的门槛是什么？'))
    // 右列编号标题各自成段，顺序保持 27→31
    const titles = paras.filter(p => /^\d{2}\./.test(p))
    assert.deepEqual(titles, ['27.怀孕和生产', '28.别为了外形把身体搞坏', '29.遭遇重大打击之后', '30.上学以后的孩子', '31.十八岁之后有哪几条路'])
})

test('双流并排页：内容零丢失', () => {
    const rows = splitColumnFlows(assembleRows(interleavedItems()))
    const joined = rows.map(r => r.text).join('')
    for (const frag of ['出院前要办哪', '些证？', '28.别为了外形把身体搞坏', '门槛是什么？', '31.十八岁之后有哪几条路']) {
        assert.ok(joined.includes(frag), `拆分丢了内容：${frag}`)
    }
})

test('单栏页：零散的行内宽间隙不会触发分栏', () => {
    const items = []
    let y = 800
    for (let i = 0; i < 12; i++) {
        items.push(item('这一段正文一直写满整行没有第二个文字块', 40, y, 22 * 12))
        y -= 20
    }
    // 一行「章标题 + 遥远页码」的宽间隙：只有一行支持，证据不足
    items.push(item('第三章', 40, y, 36))
    items.push(item('23', 500, y, 14))
    const rows = assembleRows(items)
    const after = splitColumnFlows(rows)
    assert.equal(after, rows, '证据不足时必须原样返回，不做拆分')
})

test('横跨空隙的整行（章节大标题）归入左流原位，不进右流', () => {
    const items = []
    // 顶部一条横跨整页的章标题：单个文字块从 x=40 画到 x=560
    items.push(item('第二章 生活里的关键决定', 40, 820, 520))
    let y = 780
    for (let i = 0; i < 8; i++) {
        items.push(item(`左列正文第${i + 1}行一直写到行尾`, 40, y, 13 * 12))
        items.push(item(`${32 + i}.右侧条目标题`, 420, y, 7 * 12))
        y -= 20
    }
    const rows = splitColumnFlows(assembleRows(items))
    const right = rows.filter(r => r.x0 >= 400)
    assert.equal(right.length, 8, '右流只有八条标题')
    assert.equal(rows.length, 17, '拆分后 9 条左流 + 8 条右流')
    assert.equal(rows[0].text, '第二章 生活里的关键决定', '章标题在左流最前')
})

test('行数太少（<8）不做分栏判定', () => {
    const rows = splitColumnFlows([
        { text: '甲', y: 100, x0: 40, x1: 300, h: 12 },
        { text: '乙', y: 90, x0: 40, x1: 300, h: 12 },
    ])
    assert.equal(rows.length, 2)
})
