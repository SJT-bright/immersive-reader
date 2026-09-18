// A deep link selects a local book, never a position or a remote file.
export function parseBookLink(search) {
    const values = new URLSearchParams(search).getAll('book')
    if (!values.length) return { kind: 'absent' }
    const id = values[0]
    // Includes UUIDs, the original id-* fallback and the bundled sample-book.
    if (values.length !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(id)) {
        return { kind: 'invalid', message: '书籍链接无效，请从书架重新打开。' }
    }
    return { kind: 'book', id }
}

export async function resolveBookLink(search, getBook) {
    const link = parseBookLink(search)
    if (link.kind !== 'book') return link
    const book = await getBook(link.id)
    return book
        ? { kind: 'ready', book }
        : { kind: 'missing', message: '本地阅读器中没有这本书，请先导入书籍或在书架中重新关联。' }
}
