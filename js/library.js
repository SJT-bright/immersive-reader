// 书库：导入 EPUB/TXT、最近书籍、内置示例书。
// v1.8.1：TXT 导入改用 txt-detect.js 识别编码与文件名书名作者，记录附 txtReport 转换报告。

import * as db from './db.js?v=1.16.0'
import { makeBook } from '../vendor/foliate-js/view.js'
import { detectText, parseTxtFilename } from './txt-detect.js?v=1.0.0'
import { splitChapters, chaptersToEpubBlob } from './txt2epub.js?v=1.5.0'
import { SAMPLE_BOOK } from './sample-book.js?v=1.4.0'

const isEpubFile = file =>
    /\.epub$/i.test(file.name) || file.type === 'application/epub+zip'

const isTxtFile = file =>
    /\.txt$/i.test(file.name) ||
    file.type === 'text/plain'

export function friendlyImportError (e, file) {
    const info = importErrorInfo(e, file)
    return info.title
}

// 分类导入失败：持续可见的错误卡片用，区分 格式不支持 / 文件损坏 / 空文件 / 其他
export function importErrorInfo (e, file) {
    const msg = String(e?.message || e)
    if (/unsupported|not supported|不是受支持的格式/i.test(msg)) {
        return { kind: 'format', title: `「${file.name}」不是受支持的格式`, hint: '当前支持可重排 EPUB、TXT（自动识别编码）和含文字的 PDF。扫描件请先 OCR；固定版式或加密电子书暂不支持。' }
    }
    // foliate 对结构缺失/损坏的报错形式多样（含 "File not found"），EPUB 一律优先按损坏解释
    if (/zip|central|end of data|corrupt|invalid|not found|container|\.opf|\.ncx/i.test(msg)) {
        return { kind: 'corrupt', title: `「${file.name}」看起来是损坏的 EPUB`, hint: 'ZIP 结构无法解析，文件可能不完整。请重新下载或复制后重试。' }
    }
    if (/没有可读的文本内容|no text|文字层/i.test(msg)) {
        return { kind: 'format', title: `「${file.name}」没有可提取的文字`, hint: '扫描版 PDF 需要先 OCR；纯图片文件无法作为书导入。' }
    }
    if (/empty|size|空文件/i.test(msg)) {
        return { kind: 'empty', title: `「${file.name}」是空文件或无法读取`, hint: '请确认文件没有损坏，或重新获取一份。' }
    }
    return { kind: 'other', title: `无法打开「${file.name}」`, hint: `原因：${msg}。固定版式或加密电子书暂不支持；TXT 乱码时可重新导入，编码会自动重新识别。` }
}

// 导入一本 EPUB/TXT → 返回书籍记录；失败抛出含友好信息的错误
export async function importBook (file) {
    if (!file || !file.size) throw new Error('空文件')
    if (file.size > 200 * 1024 * 1024) throw new Error('文件超过 200MB，暂不支持')

    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        const {pdfToReadingBook}=await import('./pdf-import.js')
        return db.addBook(await pdfToReadingBook(file))
    }

    if (isEpubFile(file)) {
        const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
        if (!(head[0] === 0x50 && head[1] === 0x4b)) {
            throw new Error(`「${file.name}」不是有效的 EPUB（缺少 ZIP 结构）。`)
        }
        const parsed = await makeBook(file)
        let title, author, cover = null
        try {
            if (parsed.rendition?.layout === 'pre-paginated') throw new Error('暂不支持固定版式 EPUB')
            if (!parsed.sections?.length) throw new Error('EPUB 没有可读章节')
            // Validate the first reading document before persisting a newly imported book.
            const section = parsed.sections.find(s => s.linear !== 'no') || parsed.sections[0]
            const doc = await section.createDocument()
            if (!doc?.documentElement || doc.querySelector('parsererror')) throw new Error('EPUB 章节内容损坏')
            const metadataText = value => typeof value === 'string' ? value : Array.isArray(value)
                ? value.map(v => typeof v === 'string' ? v : v?.name || '').join('、') : value?.name || ''
            title = metadataText(parsed.metadata?.title) || file.name.replace(/\.epub$/i, '')
            author = metadataText(parsed.metadata?.author)
            // 提取内嵌封面（失败不阻塞导入，书架回退到程序生成封面）
            try {
                const blob = await parsed.getCover?.()
                if (blob instanceof Blob && blob.size > 0 && blob.size <= 800 * 1024) cover = blob
            } catch { /* 无封面或解析失败 */ }
        } finally { parsed.destroy?.() }
        return db.addBook({
            title,
            author,
            format: 'epub',
            data: file,
            cover,
        })
    }

    if (isTxtFile(file)) {
        // 编码识别（含 BOM/UTF-16/Big5/GB18030）交给 txt-detect.js，空文本判断保留
        const { text, encoding } = await detectText(await file.arrayBuffer())
        if (!text || !text.trim()) throw new Error(`「${file.name}」没有可读的文本内容。`)
        const { title, author } = parseTxtFilename(file.name)
        const chapterList = splitChapters(text) // 章节只切一次，直接组装 EPUB
        const blob = await chaptersToEpubBlob(chapterList, title, author)
        const rec = await db.addBook({ title, author, format: 'txt', data: blob })
        // addBook 按固定字段解构，转换报告需补写后整条再持久化（小体积元数据，随记录存盘）
        rec.txtReport = { encoding, chapters: chapterList.length, chars: text.length }
        return await db.putBook(rec)
    }
    throw new Error(`「${file.name}」不是受支持的格式。当前支持可重排 EPUB、TXT 和含文字的 PDF。`)
}

// 内置示例书（原创短文）。id 固定为 sample-book，最多存在一条。
export async function ensureSampleBook () {
    const existing = await db.getBook('sample-book')
    if (existing) return existing
    const blob = await chaptersToEpubBlob(SAMPLE_BOOK.chapters, SAMPLE_BOOK.title, SAMPLE_BOOK.author)
    return db.putBook({
        id: 'sample-book',
        title: SAMPLE_BOOK.title,
        author: SAMPLE_BOOK.author,
        format: 'epub',
        data: blob,
        addedAt: Date.now(),
        lastOpenedAt: 0,
        progress: null,
    })
}

export function formatProgress (book) {
    if (!book.progress) return ''
    const pct = Math.round((book.progress.percent || 0) * 100)
    return pct > 0 ? `${pct}%` : ''
}
