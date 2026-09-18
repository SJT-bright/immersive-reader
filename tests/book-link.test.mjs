import test from 'node:test'
import assert from 'node:assert/strict'
import { parseBookLink, resolveBookLink } from '../js/book-link.js'

test('no book parameter keeps the normal restore path without querying a book', async () => {
    const result = await resolveBookLink('?view=reading', () => { throw new Error('unexpected lookup') })
    assert.deepEqual(result, { kind: 'absent' })
})

test('book IDs retain UUID, legacy and sample compatibility', () => {
    for (const id of ['44cd2868-908e-4485-b69e-a20681e82f0a', 'id-mgd12-abc123', 'sample-book']) {
        assert.deepEqual(parseBookLink(`?book=${encodeURIComponent(id)}`), { kind: 'book', id })
    }
})

test('invalid and ambiguous links do not query local storage', async () => {
    for (const search of ['?book=', '?book=one&book=two', '?book=%00x', '?book=%20abc', '?book=../x', '?book=https://other.test/a', '?book=' + 'x'.repeat(121)]) {
        const result = await resolveBookLink(search, () => { throw new Error('unexpected lookup') })
        assert.equal(result.kind, 'invalid', search)
    }
})

test('the original record and its position are passed through without modification', async () => {
    const book = Object.freeze({ id: 'test-book', progress: Object.freeze({ cfi: 'epubcfi(/6/4!/4/2)', fraction: 0.42 }) })
    const result = await resolveBookLink('?book=test-book&page=0&fraction=0', async id => {
        assert.equal(id, book.id)
        return book
    })
    assert.equal(result.kind, 'ready')
    assert.equal(result.book, book)
    assert.equal(result.book.progress.fraction, 0.42)
})

test('unknown books and unavailable storage remain distinct', async () => {
    assert.equal((await resolveBookLink('?book=missing', async () => undefined)).kind, 'missing')
    await assert.rejects(resolveBookLink('?book=known', async () => { throw new Error('storage unavailable') }), /storage unavailable/)
})
