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
    const rows = []
    let row = null, lastY = null
    for (const item of items) {
        if (typeof item.str !== 'string') continue
        const x = item.transform?.[4] ?? 0
        const y = item.transform?.[5] ?? 0
        const h = item.height || 10
        const end = x + (item.width || 0)
        if (!row || lastY === null || Math.abs(y - lastY) > Math.max(2, h * .35)) {
            row = { text: '', y, x0: x, x1: end, h }
            rows.push(row)
        }
        row.text += item.str
        if (!item.hasEOL && /[a-zA-Z0-9]$/.test(item.str)) row.text += ' '
        row.x1 = Math.max(row.x1, end)
        row.x0 = Math.min(row.x0, x)
        lastY = y
    }
    return rows.map(r => ({ ...r, text: r.text.replace(/\s+/g, ' ').trim() })).filter(r => r.text)
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
    const avgH = rows.reduce((s, r) => s + r.h, 0) / rows.length
    const paras = []
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i]
        const prevRow = i > 0 ? rows[i - 1] : null
        const startNew =
            !prevRow ||
            (prevRow.y - r.y) > avgH * 1.5 ||
            HARD_END.test(prevRow.text) ||
            prevRow.x1 < refX1 * .85
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
