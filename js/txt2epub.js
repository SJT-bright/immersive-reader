// 把 TXT 转成内存中的 EPUB（Blob），复用 foliate-js 的 EPUB 渲染管线。
// 正文全部经 XML 转义后写入 XHTML，TXT 永远不会被当作可信 HTML 执行。
// v1.5.0：文本解码（BOM/UTF-16/Big5/GB18030 识别）职责移交给 txt-detect.js；
// 本模块只负责章节切分与 EPUB 组装。decodeTextFile 保留为兼容包装并标记 @deprecated。

import { detectText } from './txt-detect.js'
import { reflowTextBlock } from './reflow.js'
import { yieldToUI, checkAbort } from './coop.js'

// ---------- 文本解码 ----------
// @deprecated 兼容包装：新代码请直接用 txt-detect.js 的 detectText（quality 一并透出，
// 非 'exact' 时上层要提示「编码无法确定，正文可能有乱码」）
export async function decodeTextFile (arrayBuffer) {
    const { text, encoding, quality } = await detectText(arrayBuffer)
    return { text, encoding, quality }
}

// ---------- XML 转义 ----------
// XML 1.0 只允许 #x9 #xA #xD 与 #x20-#xD7FF / #xE000-#xFFFD / #x10000-#x10FFFF。
// 老 BBS/记事本 TXT 带着 DOS EOF(\x1A)，gb18030 容错兜底也会把二进制垃圾解成 C0 控制字符，
// 混进 content.opf / toc.ncx / nav.xhtml / chapter….xhtml 会让整份文档 not well-formed：
// 结果是「书已入库但每次打不开」，章名命中时目录整本静默变空。
// 只在唯一写入口 escapeXml 上净化一次，覆盖全部写入点。
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g
const escapeXml = s => String(s ?? '')
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

// ---------- 章节切分 ----------
function looksLikeHeading (line) {
    const t = line.trim()
    if (!t || t.length > 40) return false
    if (/^第\s*[〇零一二两三四五六七八九十百千万亿\d]+\s*[章節节回卷部集篇幕场場]/.test(t)) return true
    if (/^(序章|序章|楔子|引子|尾声|后记|後記|跋|番外)(\s|：|:|·|$)/.test(t)) return true
    if (/^chapter\s+[0-9ivxlc]+/i.test(t)) return true
    return false
}

// 切分状态机：push 一行、finish 收尾。同步 splitChapters 与协作式 splitChaptersAsync
// 共用这一份规则，避免两套循环日后规则漂移。
// 缓冲按「段落块」而不是按章：空行即块边界，块关闭时立刻跑 reflowTextBlock——
// 与旧的「整章 join 后再按空行切块」逐字节等价，但最大的同步片从「一章 10 万行」
// 缩到一个段落块，几十 MB 的书也不会在单个块上冻结主线程。
function chapterSplitter () {
    const chapters = []
    let current = { title: '开篇', paragraphs: [] }
    let block = [] // 当前段落块的原始行（trim 推迟到块关闭，与旧行为一致）
    const closeBlock = () => {
        const lines = block.map(line => line.trim()).filter(Boolean)
        block = []
        if (!lines.length) return
        // 逐条 push：spread 一个 20 万行的块会超出引擎参数上限直接 RangeError
        // （无空行的超长章节就是一整块），循环展开是唯一安全的写法。
        for (const p of reflowTextBlock(lines)) current.paragraphs.push(p)
    }
    return {
        push (line) {
            if (looksLikeHeading(line)) {
                closeBlock()
                if (current.paragraphs.length) chapters.push(current)
                current = { title: line.trim().slice(0, 60), paragraphs: [] }
            } else if (!line.trim()) {
                closeBlock() // 空行 = 段落边界
            } else {
                block.push(line)
            }
        },
        finish () {
            closeBlock()
            if (current.paragraphs.length) chapters.push(current)
            if (!chapters.length) chapters.push({ title: '正文', paragraphs: ['（空文档）'] })
        },
        result: () => chapters,
    }
}

// 返回 [{ title, paragraphs: [..] }]；至少一章。
export function splitChapters (text) {
    const splitter = chapterSplitter()
    for (const line of text.replace(/\r\n?/g, '\n').split('\n')) splitter.push(line)
    splitter.finish()
    return splitter.result()
}

// 协作式版本：行为与 splitChapters 逐字节一致，但每处理一批行就让出主线程，
// 大到几十 MB 的 TXT 也不再冻结界面。onProgress({ lines, totalLines }) 可选；
// signal 中止时在下一个分片边界抛 AbortError。
export async function splitChaptersAsync (text, { slice = 20000, onProgress, signal } = {}) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    const splitter = chapterSplitter()
    for (let i = 0; i < lines.length; i++) {
        splitter.push(lines[i])
        if ((i + 1) % slice === 0) {
            checkAbort(signal)
            onProgress?.({ lines: i + 1, totalLines: lines.length })
            await yieldToUI(signal)
        }
    }
    checkAbort(signal)
    splitter.finish()
    return splitter.result()
}

// ---------- 最小 zip writer（全部 STORED 不压缩，保证 CRC 正确即可） ----------
const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
        table[n] = c >>> 0
    }
    return table
})()

function crc32 (bytes) {
    let c = 0xFFFFFFFF
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
}

const encoder = new TextEncoder()

// files: [{ name, data(Uint8Array), storeFirst? }]，storeFirst 的条目（mimetype）必须无额外字段且最先写入。
// 全部条目 STORED：EPUB 只要求 mimetype 不压缩，其余条目压缩与否都合法。这里保持不压缩，
// 一是 js/zip 之外的检查（tests/core.test.mjs 直接按字节 grep 转义结果）依赖明文字节，
// 二是 TXT 体积换 deflate 收益要靠正确的 CRC32/Adler32，不值得在没有构建步骤的项目里加风险。
// cooperative=true 时每处理完一个条目让出主线程（CRC32 是整书量级的逐字节循环）。
async function buildZip (files, { cooperative = false, onProgress, signal } = {}) {
    // 条目数写进 EOCD 的 16 位字段，超过 0xFFFF 会被 DataView.setUint16 静默截断成假 archive
    if (files.length > 0xFFFF) throw new Error(`章节文件超过 ${0xFFFF} 个，请把 TXT 拆成几本再导入`)
    const parts = []
    const central = []
    let offset = 0
    const now = new Date()
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF

    for (let index = 0; index < files.length; index++) {
        const f = files[index]
        const nameBytes = encoder.encode(f.name)
        const crc = crc32(f.data)
        const local = new DataView(new ArrayBuffer(30))
        local.setUint32(0, 0x04034b50, true)
        local.setUint16(4, 20, true) // version needed
        local.setUint16(6, f.storeFirst ? 0 : 0x0800, true) // flags：UTF-8 名
        local.setUint16(8, 0, true) // method: stored
        local.setUint16(10, dosTime, true)
        local.setUint16(12, dosDate, true)
        local.setUint32(14, crc, true)
        local.setUint32(18, f.data.length, true)
        local.setUint32(22, f.data.length, true)
        local.setUint16(26, nameBytes.length, true)
        local.setUint16(28, 0, true)
        parts.push(new Uint8Array(local.buffer), nameBytes, f.data)

        const cd = new DataView(new ArrayBuffer(46))
        cd.setUint32(0, 0x02014b50, true)
        cd.setUint16(4, 20, true)
        cd.setUint16(6, 20, true)
        cd.setUint16(8, f.storeFirst ? 0 : 0x0800, true)
        cd.setUint16(10, 0, true)
        cd.setUint16(12, dosTime, true)
        cd.setUint16(14, dosDate, true)
        cd.setUint32(16, crc, true)
        cd.setUint32(20, f.data.length, true)
        cd.setUint32(24, f.data.length, true)
        cd.setUint16(28, nameBytes.length, true)
        cd.setUint32(42, offset, true)
        central.push(new Uint8Array(cd.buffer), nameBytes)
        offset += 30 + nameBytes.length + f.data.length
        if (cooperative) {
            checkAbort(signal)
            onProgress?.({ stage: '打包 EPUB', done: index + 1, total: files.length })
            await yieldToUI(signal)
        }
    }
    const centralSize = central.reduce((s, p) => s + p.length, 0)
    const eocd = new DataView(new ArrayBuffer(22))
    eocd.setUint32(0, 0x06054b50, true)
    eocd.setUint16(8, files.length, true)
    eocd.setUint16(10, files.length, true)
    eocd.setUint32(12, centralSize, true)
    eocd.setUint32(16, offset, true)
    return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: 'application/epub+zip' })
}

// ---------- 组装 EPUB ----------
const fallbackUuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    'txt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
const STYLE_CSS = `body{margin:0;padding:0 4px;}
h2{font-weight:600;text-align:center;margin:1.2em 0 1.4em;}
p{margin:0 0 .35em;text-indent:2em;}
p.noindent{text-indent:0;}`

function chapterXhtml (title, paragraphs) {
    const body = paragraphs
        .map(p => `<p>${escapeXml(p)}</p>`)
        .join('\n')
    return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h2>${escapeXml(title)}</h2>
${body}
</body></html>`
}

// dc:identifier 与 dtb:uid 必须是同一个标识：一次构建只生成一次，两处复用。
const OPF_TMPL = (title, chapterFiles, author = '', bookId = fallbackUuid()) => `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${bookId}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    ${author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : ''}
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${chapterFiles.map((f, i) => `    <item id="c${i}" href="${f.name}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
${chapterFiles.map((f, i) => `    <itemref idref="c${i}"/>`).join('\n')}
  </spine>
</package>`

const NAV_TMPL = chapters => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title></head>
<body><nav epub:type="toc" id="toc"><h1>目录</h1><ol>
${chapters.map((c, i) => `<li><a href="${c.file}">${escapeXml(c.title)}</a></li>`).join('\n')}
</ol></nav></body></html>`

const NCX_TMPL = (title, chapters, bookId = fallbackUuid()) => `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${bookId}"/><meta name="dtb:depth" content="1"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${chapters.map((c, i) => `  <navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="${c.file}"/></navPoint>`).join('\n')}
</navMap></ncx>`

// 长章节拆分为多个小节文件，避免超大单文件渲染卡顿；目录仍指向该章首文件。
// pdfPage 原样带过去：PDF 导入是「每页一章」，一章被拆成多个 section 后
// section 序号不再等于原书页号，js/reader.js 需要这份映射才能显示对的「第 N 页」。
export function packChapters (chapters) {
    const MAX_PARAS = 160 // 每文件段数上限
    const out = [] // [{ title, file, paragraphs, pdfPage }]
    let idx = 0
    for (const ch of chapters) {
        const chunks = Math.ceil(ch.paragraphs.length / MAX_PARAS)
        for (let k = 0; k < chunks; k++) {
            const file = `chapter${String(idx).padStart(4, '0')}.xhtml`
            const label = k === 0 ? ch.title : `${ch.title}（续${k}）`
            const paras = ch.paragraphs.slice(k * MAX_PARAS, (k + 1) * MAX_PARAS)
            out.push({ title: label, file, paragraphs: paras, pdfPage: ch.pdfPage ?? null })
            idx++
        }
    }
    return out
}

// 「section 序号 → 原 PDF 页号」映射（没被拆分的页就是自身页号，缺省为 null）。
export function sectionPageMap (chapters) {
    return packChapters(chapters)
        .map(c => Number.isInteger(c.pdfPage) && c.pdfPage > 0 ? c.pdfPage : null)
}

export async function txtToEpubBlob (text, title = 'TXT 书籍', author = '', options = {}) {
    const chapters = await splitChaptersAsync(text, options)
    return chaptersToEpubBlob(chapters, title, author, options)
}

// 供内置示例书与 PDF 导入使用：直接以章节结构构建 EPUB。
// options.cooperative=true 时逐章排版与逐条打包之间让出主线程；onProgress 透传阶段进度；
// signal 中止时在下一个让步点抛 AbortError。
export async function chaptersToEpubBlob (chapters, title, author = '', { cooperative = false, onProgress, signal } = {}) {
    const packed = packChapters(chapters)
    const bookId = fallbackUuid() // dc:identifier 与 dtb:uid 复用同一个标识
    const files = [{
        name: 'mimetype',
        data: encoder.encode('application/epub+zip'),
        storeFirst: true,
    }, {
        name: 'META-INF/container.xml',
        data: encoder.encode(`<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    }]
    const chapterFiles = packed.map(c => ({ name: c.file, xhtml: chapterXhtml(c.title, c.paragraphs) }))
    files.push({
        name: 'OEBPS/content.opf',
        data: encoder.encode(OPF_TMPL(title, chapterFiles, author, bookId)),
    })
    files.push({
        name: 'OEBPS/nav.xhtml',
        data: encoder.encode(NAV_TMPL(packed)),
    })
    files.push({
        name: 'OEBPS/toc.ncx',
        data: encoder.encode(NCX_TMPL(title, packed, bookId)),
    })
    files.push({ name: 'OEBPS/style.css', data: encoder.encode(STYLE_CSS) })
    for (let i = 0; i < chapterFiles.length; i++) {
        const c = chapterFiles[i]
        files.push({ name: `OEBPS/${c.name}`, data: encoder.encode(c.xhtml) })
        if (cooperative) {
            checkAbort(signal)
            onProgress?.({ stage: '章节排版', done: i + 1, total: chapterFiles.length })
            await yieldToUI(signal)
        }
    }
    return await buildZip(files, { cooperative, onProgress, signal })
}
