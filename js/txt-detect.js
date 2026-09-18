// txt-detect.js v1.0.0 —— TXT 编码智能识别与文件名解析
// 纯函数、无 DOM 依赖，Node 与浏览器均可直接 import。
// detectText: BOM 优先 → UTF-8 严格解码 → gb18030/big5 候选严格解码并评分 → gb18030 容错兜底。
// parseTxtFilename: 从「书名 作者」类文件名中提取书名与作者。

// 常用汉字采样表：真实中文命中率应显著高于按错误编码解出的生僻字噪声
const COMMON = '的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感'
const COMMON_SET = new Set(COMMON)
// GBK 双重乱码特征串（典型于「UTF-8 字节被再按 GBK 解码」等场景）
const MOJIBAKE = ['锟斤拷', '烫烫烫', '屯屯屯', '唳唳唳']

// 对解码结果打分：CJK 占比与常用字命中率加分；替换字符、乱码串、控制字符扣分
function scoreText(text) {
    let fffd = 0, nonAscii = 0, cjk = 0, common = 0, ctrl = 0
    for (const ch of text) {
        const c = ch.codePointAt(0)
        if (c < 128) { if ((c < 32 || c === 127) && c !== 10 && c !== 13 && c !== 9) ctrl++; continue }
        nonAscii++
        if (c === 0xFFFD) fffd++
        else if (c >= 0x4E00 && c <= 0x9FFF) { cjk++; if (COMMON_SET.has(ch)) common++ }
    }
    let moji = 0
    for (const m of MOJIBAKE) { let i = text.indexOf(m); while (i !== -1) { moji++; i = text.indexOf(m, i + m.length) } }
    const cjkRatio = nonAscii ? cjk / nonAscii : 0
    const commonHit = nonAscii ? common / nonAscii : 0
    const ctrlRatio = text.length ? ctrl / text.length : 0
    return { score: cjkRatio * 2 + commonHit * 3 - ctrlRatio * 2 - moji * 0.5 - fffd * 0.05, cjkRatio, moji }
}

// 严格/容错解码，严格模式抛错时返回 null
function tryDecode(bytes, enc, fatal) {
    try { return { text: new TextDecoder(enc, { fatal }).decode(bytes) } } catch { return null }
}

// 识别文件编码并解码。入参 ArrayBuffer / TypedArray / Buffer。
// 返回 { text, encoding, quality }：
//   encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'big5'
//   quality:  'exact'（严格解码成功且可信）| 'best-effort'（容错解码，可能含替换字符）
export function detectText(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    if (!bytes.length) return { text: '', encoding: 'utf-8', quality: 'exact' }
    // 1) BOM 优先
    if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
        const r = tryDecode(bytes.subarray(3), 'utf-8', true)
        if (r) return { text: r.text, encoding: 'utf-8-bom', quality: 'exact' }
        return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8-bom', quality: 'best-effort' }
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        const r = tryDecode(bytes.subarray(2), 'utf-16le', true)
        return { text: r ? r.text : new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', quality: r ? 'exact' : 'best-effort' }
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        const r = tryDecode(bytes.subarray(2), 'utf-16be', true)
        return { text: r ? r.text : new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', quality: r ? 'exact' : 'best-effort' }
    }
    // 2) UTF-8 严格解码（ASCII 与绝大多数新文件在此命中）
    const utf8 = tryDecode(bytes, 'utf-8', true)
    if (utf8) return { text: utf8.text, encoding: 'utf-8', quality: 'exact' }
    // 3) 候选评分：gb18030 / big5 严格解码，淘汰抛错者，其余按分取最高（同分优先 gb18030）
    let best = null
    for (const enc of ['gb18030', 'big5']) {
        const r = tryDecode(bytes, enc, true)
        if (!r) continue
        const s = scoreText(r.text)
        if (!best || s.score > best.score) best = { text: r.text, encoding: enc, quality: 'exact', score: s.score }
    }
    if (best) return { text: best.text, encoding: best.encoding, quality: best.quality }
    // 4) 全部淘汰：gb18030 容错兜底
    return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'gb18030', quality: 'best-effort' }
}

// 去除首尾空白与包裹符号（书名号、引号、括号等，逐层剥离）
function stripWrap(s) {
    let r = s.trim()
    const pairs = [['《', '》'], ['〈', '〉'], ['「', '」'], ['『', '』'], ['【', '】'], ['（', '）'], ['(', ')'], ['[', ']'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"]]
    for (let changed = true; changed;) {
        changed = false
        for (const [a, b] of pairs) if (r.length >= 2 && r.startsWith(a) && r.endsWith(b)) { r = r.slice(1, -1).trim(); changed = true }
    }
    return r
}

// 按字（码点）截断
const cut = (s, n) => [...s].slice(0, n).join('')

// 从文件名解析书名与作者，识别顺序：书名号 → 横杠/by → 括号 → 冒号。
// 返回 { title, author }；都取不到时 title 为去 .txt 后的全名、author 为空。
export function parseTxtFilename(input) {
    if (typeof input !== 'string' || !input.trim()) return { title: '', author: '' }
    const name = input.trim().replace(/\.txt$/i, '').trim()
    if (!name) return { title: '', author: '' }
    const make = (title, author) => ({ title: cut(title, 80), author: cut(author, 40) })
    // 1) 全角书名号：《书名》作者 / 作者《书名》（书名号后缀优先作为作者）
    const g = name.match(/^([\s\S]*?)《([^《》]+)》([\s\S]*)$/)
    if (g) {
        const title = stripWrap(g[2])
        if (title) {
            let a = g[3].trim() ? g[3] : g[1]
            a = stripWrap(String(a).replace(/^\s*(?:by\s+)?[-–—]+\s*/i, '').replace(/\s*[-–—]+\s*(?:by\s+)?$/i, ''))
            return make(title, a)
        }
    }
    // 2) 横杠 / by：取最后一段为作者，且该段不含《》
    const segs = name.split(/—|\s+[-–]\s*(?:by\s+)?|\s+by\s+/i)
    if (segs.length >= 2) {
        const author = stripWrap(segs[segs.length - 1])
        if (author && !/《|》/.test(segs[segs.length - 1])) {
            const title = stripWrap(segs.slice(0, -1).join(' - '))
            if (title) return make(title, author)
        }
    }
    // 3) 括号作者：书名(作者) / 书名（作者） / 书名[作者]
    const p = name.match(/^([\s\S]+?)\s*[（(\[]\s*([^（()）\[\]]{1,60}?)\s*[）)\]]\s*$/)
    if (p) {
        const title = stripWrap(p[1].replace(/\s*[（(\[][^（()）\[\]]{0,60}[）)\]]\s*$/, '')) // 顺带去掉紧邻的备注括号组（如“(全集)”）
        if (title && p[2].trim()) return make(title, stripWrap(p[2]))
    }
    // 4) 冒号：作者：书名 / 作者: 书名（两段都非空）
    const c = name.match(/^([^:：]{1,60}?)\s*[:：]\s*([^\s:].*)$/)
    if (c) {
        const author = stripWrap(c[1]), title = stripWrap(c[2])
        if (title && author) return make(title, author)
    }
    return { title: cut(stripWrap(name), 80), author: '' }
}
