// 把 TXT 转成内存中的 EPUB（Blob），复用 foliate-js 的 EPUB 渲染管线。
// 正文全部经 XML 转义后写入 XHTML，TXT 永远不会被当作可信 HTML 执行。
// v1.5.0：文本解码（BOM/UTF-16/Big5/GB18030 识别）职责移交给 txt-detect.js；
// 本模块只负责章节切分与 EPUB 组装。decodeTextFile 保留为兼容包装并标记 @deprecated。

import { detectText } from './txt-detect.js?v=1.0.0'

// ---------- 文本解码 ----------
// @deprecated 兼容包装：新代码请直接用 txt-detect.js 的 detectText（还返回 quality）
export async function decodeTextFile (arrayBuffer) {
    const { text, encoding } = await detectText(arrayBuffer)
    return { text, encoding } // quality 丢弃
}

// ---------- XML 转义 ----------
const escapeXml = s => s
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

// 返回 [{ title, paragraphs: [..] }]；至少一章。
export function splitChapters (text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    const chapters = []
    let current = { title: '开篇', paragraphs: [] }
    let buf = []
    const flushBuf = () => {
        const joined = buf.join('\n').trim()
        if (joined) {
            // 段落以空行/缩进规则合并：连续非空行合为一段（中文 TXT 常见硬换行）
            const paras = joined.split(/\n\s*\n+/)
                .map(p => p.replace(/\n+/g, '').trim())
                .filter(Boolean)
            current.paragraphs.push(...paras)
        }
        buf = []
    }
    for (const line of lines) {
        if (looksLikeHeading(line)) {
            flushBuf()
            if (current.paragraphs.length) chapters.push(current)
            current = { title: line.trim().slice(0, 60), paragraphs: [] }
        } else {
            buf.push(line)
        }
    }
    flushBuf()
    if (current.paragraphs.length) chapters.push(current)
    if (!chapters.length) chapters.push({ title: '正文', paragraphs: ['（空文档）'] })
    return chapters
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
function buildZip (files) {
    const parts = []
    const central = []
    let offset = 0
    const now = new Date()
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF

    for (const f of files) {
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

const OPF_TMPL = (title, chapterFiles, author = '') => `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${fallbackUuid()}</dc:identifier>
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

const NCX_TMPL = (title, chapters) => `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${fallbackUuid()}"/><meta name="dtb:depth" content="1"/></head>
<docTitle><text>${escapeXml(title)}</text></docTitle>
<navMap>
${chapters.map((c, i) => `  <navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${escapeXml(c.title)}</text></navLabel><content src="${c.file}"/></navPoint>`).join('\n')}
</navMap></ncx>`

// 长章节拆分为多个小节文件，避免超大单文件渲染卡顿；目录仍指向该章首文件。
function packChapters (chapters) {
    const MAX_PARAS = 160 // 每文件段数上限
    const out = [] // [{ title, file, toclabel }]
    let idx = 0
    for (const ch of chapters) {
        const chunks = Math.ceil(ch.paragraphs.length / MAX_PARAS)
        for (let k = 0; k < chunks; k++) {
            const file = `chapter${String(idx).padStart(4, '0')}.xhtml`
            const label = k === 0 ? ch.title : `${ch.title}（续${k}）`
            const paras = ch.paragraphs.slice(k * MAX_PARAS, (k + 1) * MAX_PARAS)
            out.push({ title: label, file, paragraphs: paras })
            idx++
        }
    }
    return out
}

export async function txtToEpubBlob (text, title = 'TXT 书籍', author = '') {
    const chapters = splitChapters(text)
    return chaptersToEpubBlob(chapters, title, author)
}

// 供内置示例书使用：直接以章节结构构建 EPUB
export async function chaptersToEpubBlob (chapters, title, author = '') {
    const packed = packChapters(chapters)
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
        data: encoder.encode(OPF_TMPL(title, chapterFiles, author)),
    })
    files.push({
        name: 'OEBPS/nav.xhtml',
        data: encoder.encode(NAV_TMPL(packed)),
    })
    files.push({
        name: 'OEBPS/toc.ncx',
        data: encoder.encode(NCX_TMPL(title, packed)),
    })
    files.push({ name: 'OEBPS/style.css', data: encoder.encode(STYLE_CSS) })
    for (const c of chapterFiles) {
        files.push({ name: `OEBPS/${c.name}`, data: encoder.encode(c.xhtml) })
    }
    return buildZip(files)
}
