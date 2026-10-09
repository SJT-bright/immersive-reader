// PDF 段落重组：pdf.js 提取的是「物理行」，窄列排版（PPT 导出、小开本）
// 的书每行只有十几个字，若按行入库，「基础定律」会被拆成「基 / 础定律」。
// 这里先拼接物理行，再根据段距、首行缩进、短句末行判断段落。
// 短行本身不能证明段落结束：PDF 提取的「马斯 / 克」恰好会被此信号切碎。
// 句末标点配合短行才收段，逗号顿号不算。
// 全部规则只动换行不动字，内容零改写，可离线运行。

// 句末收段标点：上行以这些结尾时，下一行开新段。
const HARD_END = /[。！？…”」』）】!?.]$/
// 行首开引号/括号：即便上一行是硬换行，也不并进上一段（对话、注释常见另起）。
const LINE_OPEN = /^[“「『（【]/
// 行首项目符号或序号：列表项永远另起一段，否则「说明：」后的条目会被吞进上一段。
const LIST_OPEN = /^[·•‣∙▪▫○●◦\-–—＊*]\s*/
const NUM_OPEN = /^(?:\d{1,3}[.、)）]|[一二三四五六七八九十]{1,3}[、)）])\s*/

// 行内拼接：按 x 排序后把各片段连成行文本。英文词间/标点后补空格，中文直接相连。
function composeRowText (parts, h) {
    let text = '', end = null
    for (const part of parts) {
        const gap = end === null ? 0 : part.x - end
        const wordGap = /[a-zA-Z0-9]$/.test(text) && /^[a-zA-Z0-9]/.test(part.str)
        const punctuationGap = /[,.;:!?]$/.test(text) && /^[a-zA-Z]/.test(part.str)
        if (gap > h * .22 && (wordGap || punctuationGap)) text += ' '
        text += part.str
        end = part.x + part.width
    }
    return text.replace(/\s+/g, ' ').trim()
}

// 把 pdf.js 的 content.items（含坐标）聚合为物理行：同 Y 归一行，记录左右边界。
// 行对象保留原始 parts（含各自 x/width），供 splitColumnFlows 做分栏拆分。
export function assembleRows(items) {
    const glyphs = items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => ({
        str: item.str, x: item.transform?.[4] ?? 0, y: item.transform?.[5] ?? 0,
        h: item.height || 10, width: item.width || 0,
    }))
    // 行分组容差按全表中位字形高算一次，不用「当前字形自己的高度」：
    // 脚注上标（h≈6、基线抬高）自己的容差只有 2px，会被拆成独立一行；
    // 大字号标题行（h=40 → 阈值 14）又宽松到把紧随其后的正文并进同一行。
    const hs = glyphs.map(g => g.h).sort((a, b) => a - b)
    const medGlyphH = hs.length ? hs[Math.floor(hs.length / 2)] : 10
    const rowTolerance = Math.max(2, medGlyphH * .35)
    glyphs.sort((a, b) => b.y - a.y || a.x - b.x)
    const rows = []
    for (const glyph of glyphs) {
        let row = rows[rows.length - 1]
        if (!row || Math.abs(glyph.y - row.y) > rowTolerance) {
            row = { parts: [], y: glyph.y, ySum: glyph.y, n: 1, x0: glyph.x, x1: glyph.x + glyph.width, h: glyph.h }
            rows.push(row)
        } else {
            // 行基准线随行内均值滑动：pdf.js 同一条物理行的多个 item 常有 1-3px 的 y 抖动，
            // 只认第一个 item 的 y 会把这一行切成两行。
            row.ySum += glyph.y
            row.y = row.ySum / ++row.n
        }
        row.parts.push(glyph)
        row.x0 = Math.min(row.x0, glyph.x)
        row.x1 = Math.max(row.x1, glyph.x + glyph.width)
    }
    return rows.map(row => {
        row.parts.sort((a, b) => a.x - b.x)
        const text = composeRowText(row.parts, row.h)
        return { text, y: row.y, x0: row.x0, x1: row.x1, h: row.h, parts: row.parts }
    }).filter(row => row.text)
}

// ── 双流并排页的阅读顺序重建 ────────────────────────────────────────
// 有些排版把「正文」和「条目标题」并成两条竖直流放在同一页（左列完整
// 问句、右列编号短标题，逐行基线对齐）。assembleRows 按 Y 归行会把两股
// 流拼成一行，出现「办哪27.怀孕和生产些证？」这类串行。这里在归行之后、
// 组段之前，找贯穿多行的同一条纵向空隙（gutter），把左右两股流拆开：
// 先左列自上而下，再右列自上而下。判据刻意保守：空隙要足够宽、要被
// 足够多的行共用、两侧都要有实际内容；单栏页里居中标题、散落的宽间隙
// 凑不齐这些证据，保持原顺序不动。横跨空隙的整行（章节大标题）归入
// 左流原位，不参与右流。
export function splitColumnFlows (rows) {
    if (!Array.isArray(rows) || rows.length < 8) return rows
    const medH = median(rows.map(r => r.h)) || 10
    const minGap = Math.max(medH * 1.5, 12) // 列间距通常 ≥1.5 字高；行内普通空隙远小于此
    const bandTol = medH                     // 同一条 gutter 在不同行之间的 x 抖动
    const bands = []
    let gutterRows = 0
    for (const row of rows) {
        const parts = (row.parts || []).slice().sort((a, b) => a.x - b.x)
        let hasGap = false
        for (let i = 1; i < parts.length; i++) {
            const lo = parts[i - 1].x + parts[i - 1].width
            const hi = parts[i].x
            if (hi - lo < minGap) continue
            hasGap = true
            const hit = bands.find(b => lo < b.hi + bandTol && hi > b.lo - bandTol)
            if (hit) { hit.lo = Math.min(hit.lo, lo); hit.hi = Math.max(hit.hi, hi); hit.support++ }
            else bands.push({ lo, hi, support: 1 })
        }
        if (hasGap) gutterRows++
    }
    const best = bands.filter(b => b.support >= 4).sort((a, b) => b.support - a.support)[0]
    // 共用这条空隙的行要占「有宽间隙的行」的多数，也要占整页行数的可观比例
    if (!best || best.support < gutterRows * .6 || best.support < rows.length * .25) return rows
    const lo = best.lo + bandTol * .5, hi = best.hi - bandTol * .5
    const left = [], right = []
    for (const row of rows) {
        const leftParts = [], rightParts = []
        for (const p of (row.parts || [])) {
            // 每个片段都必须归边，绝不静默丢弃：列边界有抖动的碎片按就近一侧归属
            if (p.x >= hi) rightParts.push(p)
            else if (p.x + p.width <= lo) leftParts.push(p)
            else if (p.x < lo && p.x + p.width > hi) leftParts.push(p) // 横跨整页的整行（章节大标题）归左流
            else if ((p.x + p.width - lo) <= (hi - p.x)) leftParts.push(p)
            else rightParts.push(p)
        }
        leftParts.sort((a, b) => a.x - b.x)
        rightParts.sort((a, b) => a.x - b.x)
        if (leftParts.length) left.push({
            text: composeRowText(leftParts, row.h), y: row.y,
            x0: Math.min(...leftParts.map(p => p.x)),
            x1: Math.max(...leftParts.map(p => p.x + p.width)), h: row.h,
        })
        if (rightParts.length) right.push({
            text: composeRowText(rightParts, row.h), y: row.y,
            x0: Math.min(...rightParts.map(p => p.x)),
            x1: Math.max(...rightParts.map(p => p.x + p.width)), h: row.h,
        })
    }
    if (left.length < 3 || right.length < 3) return rows
    return [...left, ...right]
}

// 两行拼接：英文补词间距，连字符断词复原；中文直接相连。
function joinLines(a, b) {
    if (/[a-zA-Z0-9]$/.test(a) && /^[a-zA-Z0-9]/.test(b)) return a + ' ' + b
    if (a.endsWith('-') && /^[a-zA-Z]/.test(b)) return a.slice(0, -1) + b
    return a + b
}

// 正文列右边界：正文行（两端对齐/中文满行）的 x1 几乎相同，标题、页眉、页码、句末短行都散开。
// 取「共用行数最多的那一带的右边界」；一屏里没有任何一带被多行共用时（整页只有两三行）证据不足，
// 退到上中位数——绝不能用最大值，否则一条横跨整页的页眉就独占基准，
// 正文行全都「显得很短」：页眉被粘进正文、段落被句末判据切碎。
function columnRightEdge (rows, medH) {
    const xs = rows.map(r => r.x1).sort((a, b) => a - b)
    if (!xs.length) return 0
    const tol = Math.max(4, medH)
    let best = { count: 0, value: 0 }
    for (let i = 0, hi = 0; i < xs.length; i++) {
        while (hi < xs.length && xs[hi] - xs[i] <= tol) hi++
        const count = hi - i
        // 用带内最宽的一条代表列边（388/390 这种 1px 抖动应当算同一条列边）
        if (count > best.count || (count === best.count && xs[hi - 1] > best.value)) {
            best = { count, value: xs[hi - 1] }
        }
    }
    return best.count > 1 ? best.value : xs[Math.floor(xs.length / 2)]
}

const median = values => {
    const s = [...values].sort((a, b) => a - b)
    return s.length ? s[Math.floor(s.length / 2)] : 0
}

// 物理行 → 段落。没有可靠分段信号的相邻物理行并入同段。
export function rowsToParas(rows) {
    if (!rows.length) return []
    const allMedH = median(rows.map(r => r.h)) || 10
    const wideRef = columnRightEdge(rows, allMedH) || Math.max(...rows.map(r => r.x1), 1)
    // 页眉/页脚/页码只可能出现在页首页尾若干行；正文中间的短行是被切断的句子，不能当噪声。
    const EDGE = 3
    const isEdgeNoise = (r, i) => {
        if (i >= EDGE && i < rows.length - EDGE) return false
        if (HARD_END.test(r.text) || LIST_OPEN.test(r.text) || NUM_OPEN.test(r.text)) return false
        if (r.text.length > 16) return false // 长行按正文处理，绝不吞掉内容
        if (/\d/.test(r.text) && r.x1 < wideRef * .6) return true // 页码：明显更窄且带数字
        if (r.x1 > wideRef * 1.08) return true // 比正文列更宽 = 横跨整页的页眉/页脚
        return false
    }
    const noise = rows.map(isEdgeNoise)
    // 基准统计只算正文行：标题、页眉、页码是少数，不该拉动正文基准。
    const body = rows.filter((_, i) => !noise[i])
    const stat = body.length ? body : rows
    const refX1 = columnRightEdge(stat, allMedH) || Math.max(...stat.map(r => r.x1), 1)
    const medH = median(stat.map(r => r.h)) || 10
    const baseX0 = median(stat.map(r => r.x0)) || 0
    const paras = []
    // 段间隙阈值自适应：正常行距在一页里远多于段距，取行距下四分位当基准。
    // 固定「1.5 倍行高」会卡在行距 1.5 的书上（正常行距恰好越线，段内被切碎）。
    const gaps = []
    for (let i = 1; i < rows.length; i++) gaps.push(rows[i - 1].y - rows[i].y)
    gaps.sort((a, b) => a - b)
    const baseGap = gaps.length ? gaps[Math.floor(gaps.length * .25)] : medH * 1.5
    const gapMax = Math.max(baseGap * 1.35, medH * 1.8)
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        const prevRow = i > 0 ? rows[i - 1] : null
        const prevNoise = i > 0 && noise[i - 1]
        // 页首几行里明显短于正文列宽且不带句末标点的是小标题而不是被切断的句子：
        // 正文行（含跨页续行）都是满宽的，半句只会出现在页中。原来只判第一行，
        // 页眉占两三行的书页就把第二、三行的标题漏成了正文。
        const prevIsHeading = !!prevRow && i <= EDGE &&
            prevRow.x1 < refX1 * .6 && !HARD_END.test(prevRow.text)
        const startNew =
            noise[i] ||                       // 页眉/页脚/页码单独成段，绝不并进正文
            prevNoise ||                      // 紧跟页眉的正文行另起一段（否则被页眉吞掉）
            !prevRow ||
            (prevRow.y - r.y) > gapMax ||     // 行距骤增 = 段落间空隙
            r.x0 > baseX0 + medH * .9 ||      // 首行缩进两字（中文常规）
            prevIsHeading ||
            LIST_OPEN.test(r.text) ||         // 项目符号 / 序号永远另起一段
            NUM_OPEN.test(r.text) ||
            LINE_OPEN.test(r.text) ||
            (HARD_END.test(prevRow.text) && prevRow.x1 < refX1 * .9) // 短句末行 = 段末
        if (startNew) paras.push(r.text)
        else paras[paras.length - 1] = joinLines(paras[paras.length - 1], r.text)
    }
    return paras
}

// 纯文本兜底：没有几何信息时（行宽未知）按「上一行无句末标点即合并」处理。
// 供行宽信号不可用的调用方使用，规则刻意保守。
export function reflowTextLines(lines) {
    const list = Array.isArray(lines) ? lines.filter(l => typeof l === 'string' && l.trim()) : []
    if (!list.length) return []
    // 页首那行若明显短于本页行长的中位数，它是小标题：正文行（含跨页续行）都是满宽的。
    const lens = list.map(l => l.length).sort((a, b) => a - b)
    const medLen = lens[Math.floor(lens.length / 2)] || 0
    const firstIsHeading = list.length > 1 && medLen > 0 &&
        list[0].length < medLen * .6 && !HARD_END.test(list[0])
    const out = []
    for (let i = 0; i < list.length; i++) {
        const line = list[i]
        const prev = out[out.length - 1]
        // 只挡住「标题吞掉下一行」这一处，其余合并照常
        if (i === 1 && firstIsHeading) { out.push(line); continue }
        if (prev && !HARD_END.test(prev) &&
            !LINE_OPEN.test(line) && !LIST_OPEN.test(line) && !NUM_OPEN.test(line)) {
            out[out.length - 1] = joinLines(prev, line)
        } else out.push(line)
    }
    return out
}

// ── 纯 TXT 的段落合并（txt2epub 用）───────────────────────────────────
// 自动换行的散文（一行 20-40 字、只有末行短）该把硬换行接回去；诗歌、剧本、古籍唱本、
// 以「：」「，」收尾的条目里硬换行就是内容边界，合并会把行结构不可逆地抹掉。
// 按块判定：中位行长很短（≤ VERSE_MAX_LINE 字）且多数行不带句末标点 → 保留逐行为段。
export const VERSE_MAX_LINE = 14

export function isVerseBlock (lines) {
    const list = Array.isArray(lines) ? lines.filter(l => typeof l === 'string' && l.trim()) : []
    if (list.length < 3) return false
    const medLen = median(list.map(l => l.trim().length))
    if (!(medLen > 0 && medLen <= VERSE_MAX_LINE)) return false
    const noEnd = list.filter(l => !HARD_END.test(l.trim())).length
    return noEnd / list.length >= .5
}

export function reflowTextBlock (lines) {
    const list = Array.isArray(lines) ? lines.filter(l => typeof l === 'string' && l.trim()) : []
    if (!list.length) return []
    if (isVerseBlock(list)) return list.map(l => l.trim())
    return reflowTextLines(list)
}
