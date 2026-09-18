import test from 'node:test'
import assert from 'node:assert/strict'
import {
    nextSentenceFromText, splitSentences, passageFromText,
    placeLabel, noteCounts, normalizeNote, pageLabel,
    makeQuoteNote, makeBookmarkNote,
} from '../js/notes.js'

test('从原句后面的余文里取出下一句', () => {
    assert.equal(nextSentenceFromText('  山门还在雾里。溪声更近了。'), '山门还在雾里。')
    assert.equal(nextSentenceFromText('Hello world. Next.'), 'Hello world.')
    assert.equal(nextSentenceFromText('没有句号的一段话'), '没有句号的一段话')
    assert.equal(nextSentenceFromText(''), '')
    assert.equal(nextSentenceFromText('。下一句在这里！再下一句。'), '下一句在这里！')
})

test('拆句与当前段/下一段', () => {
    assert.deepEqual(splitSentences('甲。乙！丙？丁'), ['甲。', '乙！', '丙？', '丁'])
    assert.deepEqual(passageFromText('先看见山。再听见水。然后坐下。'), { text: '先看见山。', after: '再听见水。' })
    assert.deepEqual(passageFromText(''), { text: '', after: '' })
})

test('页码与位置标签', () => {
    assert.equal(pageLabel({ pageItemLabel: '12' }), '12')
    assert.equal(pageLabel({ location: 8 }), '8')
    assert.equal(pageLabel({ location: 0.42 }), '')
    assert.equal(placeLabel({ page: '12', chapter: '山门' }), '第 12 页 · 山门')
    assert.equal(placeLabel({ chapter: '山门' }), '山门')
    assert.equal(placeLabel({}), '')
})

test('笔记按书计数，规范化保留下一句和页码', () => {
    const notes = [
        { id: 'q1', type: 'quote', cfi: 'epubcfi(/6/2!/4)', text: '原句。', after: '下一句。', page: '3', chapter: '一', comment: '', createdAt: 1 },
        { id: 'b1', type: 'bookmark', cfi: 'epubcfi(/6/4!/4)', text: '书签', after: '', page: '4', chapter: '二', comment: '', createdAt: 2 },
    ]
    assert.deepEqual(noteCounts(notes), { quotes: 1, bookmarks: 1, total: 2 })
    const n = normalizeNote(notes[0])
    assert.equal(n.after, '下一句。')
    assert.equal(n.page, '3')
    assert.equal(normalizeNote({ type: 'quote', cfi: 'javascript:x', id: 'x' }), null)
})

test('划线与书签构造带原句和下一句', () => {
    const quote = makeQuoteNote({
        cfi: 'epubcfi(/6/2!/4/2/1:0)',
        text: '山门还在雾里。',
        after: '溪声更近了。',
        chapter: '第一章',
        page: '2',
        id: 'n1',
    })
    assert.equal(quote.type, 'quote')
    assert.equal(quote.after, '溪声更近了。')
    assert.equal(quote.page, '2')
    const mark = makeBookmarkNote(
        { cfi: 'epubcfi(/6/4)', tocLabel: '第二章', pageItemLabel: '14' },
        { text: '灯还亮着。', after: '人还在书里。' },
    )
    assert.equal(mark.type, 'bookmark')
    assert.equal(mark.text, '灯还亮着。')
    assert.equal(mark.after, '人还在书里。')
    assert.equal(mark.page, '14')
    assert.equal(placeLabel(mark), '第 14 页 · 第二章')
})
