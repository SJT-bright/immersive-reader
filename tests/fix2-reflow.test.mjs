// 修复批次 F2 的 reflow 单测：页眉/页脚不再拉动正文列宽基准、物理行按全表统一容差聚合、
// 纯 TXT 的诗歌/剧本保留逐行结构。断言全部针对行为输出，不比对常量。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assembleRows, rowsToParas, reflowTextBlock, isVerseBlock } from '../js/reflow.js'

// 造一条已聚合的物理行（直接喂 rowsToParas）
function row(text, y, { x0 = 40, x1 = 390, h = 12 } = {}) {
    return { text, y, x0, x1, h }
}
// 造一条 pdf.js 的 text item
function item(str, x, y, width, h = 12) {
    return { str, transform: [1, 0, 0, 1, x, y], width, height: h }
}

test('F2-5 横跨整页的页眉不再被当成正文列宽基准', () => {
    // 审计复现：两条正文行 x1=390 ＋一条页眉 x1=520（横跨整页，比正文列更宽）
    const rows = [
        row('第一性原理', 700, { x1: 520 }),
        row('将事物拆解至最基本的原理。首先问自己：我最确信', 684, { x1: 390 }),
        row('为真的基础定律有哪些。', 668, { x1: 250 }),
    ]
    const paras = rowsToParas(rows)
    // 页眉单独成段（旧实现把它粘进正文第一句）
    assert.equal(paras[0], '第一性原理')
    // 正文两句仍是同一段（旧实现按 520 当列宽，第二行被「短句末行」判据切碎）
    assert.equal(paras[1], '将事物拆解至最基本的原理。首先问自己：我最确信为真的基础定律有哪些。')
    assert.equal(paras.length, 2)
})

test('F2-5 页码行自成一段，正文内容一个字都不丢', () => {
    const rows = [
        row('这一段正文一直写到行尾还没有写完所以是满宽的', 700, { x1: 390 }),
        row('最后一行。', 684, { x1: 200 }),
        row('第 7 页', 640, { x1: 120 }),
    ]
    const paras = rowsToParas(rows)
    assert.deepEqual(paras, ['这一段正文一直写到行尾还没有写完所以是满宽的最后一行。', '第 7 页'])
    // 判定为页眉/页码的行也只是单独成段，绝不静默删除内容
    for (const r of rows) assert.ok(paras.join('').includes(r.text), `丢了内容：${r.text}`)
})

test('F2-5 正文中间的短行不当页眉处理（跨页续行照常合并）', () => {
    // 八行一页：第 5 行（页中）是被切断的半句，很短但没有句末标点。
    // 它既不该被当成页眉/页码剔除，也不该被当成小标题把后面的正文另起一段。
    const lines = [
        '思想在传播过程中措辞会随时间与媒介改变，这一行写满到右边',
        '为止。下面这句另起一句但仍属于同一段，接下去继续说明，',
        '而下面这句又接着往下说，仍然属于同一个段落的内容，',
        '并且继续补充说明，一直写到下一行才结束，',
        '半句',
        '这就是为什么不能只凭行短就判定段落边界，',
        '因为被切断的词会先被误认成标题，',
        '所以这里必须把整段接回去。',
    ]
    const rows = lines.map((text, i) => row(text, 700 - i * 16, { x1: i === 4 ? 76 : 390 }))
    const paras = rowsToParas(rows)
    assert.equal(paras.length, 1, `段内被切碎：${JSON.stringify(paras)}`)
    assert.equal(paras[0], lines.join(''))
})

test('F2-5 页首连续几行的小标题都不吞正文', () => {
    const rows = [
        row('关于本书的重要说明', 700, { x1: 190 }),
        row('第二行副标题同样很短', 684, { x1: 200 }),
        row('本书致力于用马斯克的原话呈现其思想精华。', 668, { x1: 390 }),
        row('我完全以他迄今为止分享的文字记录为基础。', 652, { x1: 390 }),
    ]
    const paras = rowsToParas(rows)
    assert.deepEqual(paras, [
        '关于本书的重要说明',
        '第二行副标题同样很短',
        '本书致力于用马斯克的原话呈现其思想精华。我完全以他迄今为止分享的文字记录为基础。',
    ])
})

test('F2-6 脚注上标回到它所在的那一行', () => {
    // 上标 h=6、基线抬高 3px：旧实现按「当前字形自己高度」算容差 → 2px，被拆成独立一行
    const rows = assembleRows([
        item('基础定律', 40, 700, 48),
        item('12', 88, 703, 8, 6),
        item('是公理', 96, 700, 36),
        item('下一行正文从这里开始写。', 40, 684, 144),
    ])
    assert.deepEqual(rows.map(r => r.text), ['基础定律12是公理', '下一行正文从这里开始写。'])
})

test('F2-6 大字号标题行不把紧随的正文并进同一行', () => {
    // 旧实现容差 = max(2, 40*.35)=14，标题与正文行距 16 只差一点就被并进同一行
    const rows = assembleRows([
        item('第一章', 40, 760, 120, 40),
        item('正文首行从这里开始写满一行。', 40, 744, 160),
    ])
    assert.deepEqual(rows.map(r => r.text), ['第一章', '正文首行从这里开始写满一行。'])
})

test('F2-6 同一物理行内 1-3px 的 y 抖动不会把行切开', () => {
    // 行基准取行内均值：三个 item 各带一点抖动仍应聚成一行
    const rows = assembleRows([
        item('第一', 40, 700, 24),
        item('第二', 64, 702, 24),
        item('第三', 88, 699, 24),
        item('下一行', 40, 686, 36),
    ])
    assert.equal(rows.length, 2)
    assert.equal(rows[0].text, '第一第二第三')
    assert.ok(Math.abs(rows[0].y - 700.334) < 0.01, `行基准应为行内均值，实得 ${rows[0].y}`)
})

test('F2-12 诗歌块保留逐行结构，散文块照常合并', () => {
    const poem = ['床前明月光，', '疑是地上霜。', '举头望明月，', '低头思故乡。']
    assert.equal(isVerseBlock(poem), true)
    assert.deepEqual(reflowTextBlock(poem), poem)

    const prose = ['将事物拆解至最基本的原理。首先问自己：我最确信为真的基础定律有哪',
        '些？将这些定律确立为公理，以此为基础展开推理，然后再用这些公理来检验你的',
        '结论。']
    assert.equal(isVerseBlock(prose), false)
    assert.deepEqual(reflowTextBlock(prose), [prose.join('')])
})

test('F2-12 剧本与以冒号收尾的条目不被粘成一整段', () => {
    const drama = ['鲁贵：', '太太，您喊我么？', '周朴园：', '没有别的事么？']
    assert.deepEqual(reflowTextBlock(drama), drama)
    const entries = ['书名：山中的信', '作者：佚名', '字数：十二万', '版本：校对稿']
    assert.deepEqual(reflowTextBlock(entries), entries)
})

test('F2-12 空与非法输入安全', () => {
    assert.deepEqual(reflowTextBlock([]), [])
    assert.deepEqual(reflowTextBlock(['', ' ']), [])
    assert.equal(isVerseBlock(null), false)
    assert.deepEqual(reflowTextBlock(null), [])
})
