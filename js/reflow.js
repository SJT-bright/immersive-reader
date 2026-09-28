// PDF 段落重组：pdf.js 提取的是「物理行」，窄列排版（PPT 导出、小开本）
// 的书每行只有十几个字，若按行入库，「基础定律」会被拆成「基 / 础定律」。
// 这里用两组信号把行重新拼成段：
//   几何 —— 行右边界是否接近本页最长行（满行 = 硬换行；不满 = 段末或标题），
//           行间距是否骤增（1.5 倍行高以上 = 段落间空隙）；
//   标点 —— 行尾是句末标点（。！？…」』）则收段，逗号顿号不算。
// 全部规则只动换行不动字，内容零改写，可离线运行。

// 句末收段标点：上行以这些结尾时，下一行开新段。
const HARD_END = /[。！？…”」』）】!?.]$/
// 行首开引号/括号：即便上一行是硬换行，也不并进上一段（对话、注释常见另起）。
const LINE_OPEN = /^[“「『（【]/

// 把 pdf.js 的 content.items（含坐标）聚合为物理行：同 Y 归一行，记录左右边界。
export function assembleRows(items) {
    const glyphs = items.filter(item => typeof item.str === 'string' && item.str.trim()).map(item => ({
        str: item.str, x: item.transform?.[4] ?? 0, y: item.transform?.[5] ?? 0,
        h: item.height || 10, width: item.width || 0,
    })).sort((a, b) => b.y - a.y || a.x - b.x)
    const rows = []
    for (const glyph of glyphs) {
        let row = rows[rows.length - 1]
        if (!row || Math.abs(glyph.y - row.y) > Math.max(2, glyph.h * .35)) {
            row = { parts: [], y: glyph.y, x0: glyph.x, x1: glyph.x + glyph.width, h: glyph.h }
            rows.push(row)
        }
        row.parts.push(glyph)
        row.x0 = Math.min(row.x0, glyph.x)
        row.x1 = Math.max(row.x1, glyph.x + glyph.width)
    }
    return rows.map(row => {
        row.parts.sort((a, b) => a.x - b.x)
        let text = '', end = null
        for (const part of row.parts) {
            const gap = end === null ? 0 : part.x - end
            const wordGap = /[a-zA-Z0-9]$/.test(text) && /^[a-zA-Z0-9]/.test(part.str)
            const punctuationGap = /[,.;:!?]$/.test(text) && /^[a-zA-Z]/.test(part.str)
            if (gap > row.h * .22 && (wordGap || punctuationGap)) text += ' '
            text += part.str
            end = part.x + part.width
        }
        return { text: text.replace(/\s+/g, ' ').trim(), y: row.y, x0: row.x0, x1: row.x1, h: row.h }
    }).filter(row => row.text)
}

// 两行拼接：英文补词间距，连字符断词复原；中文直接相连。
function joinLines(a, b) {
    if (/[a-zA-Z0-9]$/.test(a) && /^[a-zA-Z0-9]/.test(b)) return a + ' ' + b
    if (a.endsWith('-') && /^[a-zA-Z]/.test(b)) return a.slice(0, -1) + b
    return a + b
}

// 物理行 → 段落。满行且无句末标点 = 原书硬换行，并入上一段。
export function rowsToParas(rows) {
    if (!rows.length) return []
    const refX1 = Math.max(...rows.map(r => r.x1), 1)
    // 行高 / 左边界取中位数：标题、页眉、页码是少数，不该拉动正文基准。
    const hs = rows.map(r => r.h).sort((a, b) => a - b)
    const medH = hs[Math.floor(hs.length / 2)] || 10
    const xs = rows.map(r => r.x0).sort((a, b) => a - b)
    const baseX0 = xs[Math.floor(xs.length / 2)] || 0
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
        const startNew =
            !prevRow ||
            (prevRow.y - r.y) > gapMax ||           // 行距骤增 = 段落间空隙
            r.x0 > baseX0 + medH * .9 ||            // 首行缩进两字（中文常规）
            (HARD_END.test(prevRow.text) && prevRow.x1 < refX1 * .9) ||
            prevRow.x1 < refX1 * .85                // 上一行不满 = 段末
        if (startNew) paras.push(r.text)
        else paras[paras.length - 1] = joinLines(paras[paras.length - 1], r.text)
    }
    return paras
}

// 纯文本兜底：没有几何信息时（行宽未知）按「上一行无句末标点即合并」处理。
// 供行宽信号不可用的调用方使用，规则刻意保守。
export function reflowTextLines(lines) {
    const out = []
    for (const line of lines) {
        const prev = out[out.length - 1]
        if (prev && !HARD_END.test(prev) && !LINE_OPEN.test(line)) out[out.length - 1] = joinLines(prev, line)
        else out.push(line)
    }
    return out
}
