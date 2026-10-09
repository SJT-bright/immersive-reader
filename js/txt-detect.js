// txt-detect.js v1.0.0 —— TXT 编码智能识别与文件名解析
// 纯函数、无 DOM 依赖，Node 与浏览器均可直接 import。
// detectText: UTF-16 BOM → UTF-8 严格解码（样本判定＋整体一次解码）→
//             gb18030/big5 候选严格解码并评分（带 UTF-8 BOM 时 best-effort UTF-8 同场比分）→
//             gb18030 容错兜底。判定只读文件头 512KB，见 SAMPLE_LIMIT。
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
    const asciiRatio = text.length ? (text.length - nonAscii - ctrl) / text.length : 0
    return { score: cjkRatio * 2 + commonHit * 3 - ctrlRatio * 2 - moji * 0.5 - fffd * 0.05, cjkRatio, moji, asciiRatio }
}

// 严格/容错解码，严格模式抛错时返回 null
function tryDecode(bytes, enc, fatal) {
    try { return { text: new TextDecoder(enc, { fatal }).decode(bytes) } } catch { return null }
}

// 判定编码只看文件头这么多字节：20MB 的 GBK 全本做 3 次全量解码＋2 次全量逐码点评分
// 会在工作表格里把主线程按住 1.7 秒。确定编码之后整体只解码一次。
const SAMPLE_LIMIT = 512 * 1024

// 取样本并给出「样本内严格解码」的调用方式。
// 样本被砍断时最后一个字符只剩半截：用 stream 模式解码，让它留在缓冲区而不是抛错，
// 否则一个纯粹的切点问题会被误判成「这个编码不对」（中文正文连续 512KB 不带 ASCII 很常见，
// 中文标点同样是多字节）。文件本身小于样本量时不启用 stream，保持原有整文件严格解码语义。
function sampleOf(bytes) {
    const truncated = bytes.length > SAMPLE_LIMIT
    const sample = truncated ? bytes.subarray(0, SAMPLE_LIMIT) : bytes
    return {
        truncated,
        strict(enc) {
            try {
                return { text: new TextDecoder(enc, { fatal: true })
                    .decode(sample, truncated ? { stream: true } : undefined) }
            } catch { return null }
        },
        loose(enc) {
            try { return new TextDecoder(enc).decode(sample) } catch { return '' }
        },
    }
}

// 识别文件编码并解码。入参 ArrayBuffer / TypedArray / Buffer。
// 返回 { text, encoding, quality }：
//   encoding: 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'big5'
//   quality:  'exact'（严格解码成功且可信）| 'best-effort'（容错解码，可能含替换字符）
//             非 'exact' 时上层应当提示用户（library.js 把它写进 txtReport.quality）
//   注意：exact 的判定基于前 512KB 样本；样本之后的字节按容错解码，不再回头重扫。
export function detectText(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    if (!bytes.length) return { text: '', encoding: 'utf-8', quality: 'exact' }
    // 1) BOM 优先
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        const r = tryDecode(bytes.subarray(2), 'utf-16le', true)
        return { text: r ? r.text : new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le', quality: r ? 'exact' : 'best-effort' }
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        const r = tryDecode(bytes.subarray(2), 'utf-16be', true)
        return { text: r ? r.text : new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be', quality: r ? 'exact' : 'best-effort' }
    }
    const hasUtf8Bom = bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF
    const body = hasUtf8Bom ? bytes.subarray(3) : bytes
    const utf8Name = hasUtf8Bom ? 'utf-8-bom' : 'utf-8'
    // 1.5) 无 BOM 的 UTF-16：NUL 字节在文件头异常密集就是它。'H\0e\0l\0' 里的 NUL
    // 是「合法 UTF-8」，旧逻辑会当 UTF-8 精确解出夹满 NUL 的书且不告警；中文无 BOM
    // UTF-16 则会掉进 gb18030 评分产整本乱码。零字节奇偶位置判端序。
    if (body.length >= 4) {
        const head = body.subarray(0, Math.min(4096, body.length))
        let zeros = 0, zerosOdd = 0
        for (let i = 0; i < head.length; i++) {
            if (head[i] === 0) { zeros++; if (i % 2 === 1) zerosOdd++ }
        }
        if (zeros / head.length > 0.25) {
            const enc = zerosOdd >= (zeros - zerosOdd) ? 'utf-16le' : 'utf-16be'
            const r = tryDecode(body, enc, true)
            return { text: r ? r.text : new TextDecoder(enc).decode(body), encoding: enc, quality: r ? 'exact' : 'best-effort' }
        }
    }
    const sample = sampleOf(body)
    // 2) UTF-8 严格解码（ASCII 与绝大多数新文件在此命中）：样本过关后再整体严格解一次
    if (sample.strict('utf-8')) {
        const full = tryDecode(body, 'utf-8', true)
        if (full) return { text: full.text, encoding: utf8Name, quality: 'exact' }
        // 样本之后才出现坏字节：仍按 UTF-8 容错解码，不该退到 gb18030 去产整本乱码
        return { text: new TextDecoder('utf-8').decode(body), encoding: utf8Name, quality: 'best-effort' }
    }
    // 3) 候选评分：gb18030 / big5 严格解码，淘汰抛错者，其余按分取最高（同分优先 gb18030）。
    //    带 UTF-8 BOM 但正文严格解码失败时（校对工具/合并器产出的 BOM+GBK 文件），
    //    best-effort 的 UTF-8 也只是一个候选参与比分，不能再直接返回——原实现在这里
    //    整条跳过评分，导入的是一堆 U+FFFD。
    let best = null
    for (const enc of ['gb18030', 'big5']) {
        const r = sample.strict(enc)
        if (!r) continue
        const s = scoreText(r.text)
        if (!best || s.score > best.score) best = { encoding: enc, label: enc, quality: 'exact', score: s.score, cjkRatio: s.cjkRatio, asciiRatio: s.asciiRatio }
    }
    if (hasUtf8Bom) {
        const score = scoreText(sample.loose('utf-8')).score
        if (!best || score > best.score) best = { encoding: utf8Name, label: 'utf-8', quality: 'best-effort', score, cjkRatio: 0, asciiRatio: 1 }
    }
    // 确定编码后整体只解码一次；'utf-8-bom' 只是对外报告的名字，TextDecoder 不认它。
    // 精确判定要过评分下限：gb18030 双字节覆盖极密，西文旧编码/二进制/被截断的
    // UTF-16 残片几乎总能「严格解码成功」，甚至凑出一个 cjkRatio=1.0 的孤立汉字——
    // 三条判据一起卡：总分、CJK 占比、ASCII 占比（「精确的中文编码」不该解出
    // 大半是 ASCII 的样本）。不过线就降级为 best-effort，让上层如实提示
    // 「编码无法确定」，而不是给乱码盖「精确」章。
    if (best) {
        const exactOk = best.encoding === 'utf-8' || best.encoding === 'utf-8-bom' ||
            (best.score > 0.5 && (best.cjkRatio || 0) >= 0.2 && (best.asciiRatio || 0) < 0.5)
        return {
            text: new TextDecoder(best.label).decode(body),
            encoding: best.encoding,
            quality: exactOk ? best.quality : 'best-effort',
        }
    }
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
