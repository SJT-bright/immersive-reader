// QQ 音乐子模块修复的判定用例（对应台账 F4-8 / F4-9）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// qq-music.js 只用到少量 DOM：这里造一个最小宿主，能记录「谁写了 DOM」即可。
globalThis.document = {
    addEventListener() {},
    hidden: false,
    createElement: () => ({
        setAttribute () {}, classList: { toggle () {}, add () {}, remove () {} },
        replaceChildren () {}, style: {}, dataset: {},
    }),
}
globalThis.window = { addEventListener() {} }

const { parseQQLink, deriveQQTitle, QQMusicPanel } = await import('../js/qq-music.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const src = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

// ── F4-8b：导入时把已知的歌名信息写进 title ──────────────────────────

test('deriveQQTitle 从分享文本里取出歌名', () => {
    assert.equal(deriveQQTitle('《晴天》 https://c6.y.qq.com/base/fcgi-bin/u?__=AbCdEf'), '晴天')
    assert.equal(deriveQQTitle('我在QQ音乐分享了歌曲《稻香》 点击链接 → https://c6.y.qq.com/base/fcgi-bin/u?__=AbCdEf'), '稻香')
    assert.equal(deriveQQTitle('分享单曲: "Hello World" https://y.qq.com/n/ryqq/songDetail/12345'), 'Hello World')
    assert.equal(deriveQQTitle('  《 孤勇者 》  '), '孤勇者')
})

test('deriveQQTitle 拿不到歌名时返回空串（纯链接/纯数字 ID 里本来就没有名字）', () => {
    // parseQQLink 只解析链接，不发网络请求；这类输入无歌名可取，列表回退显示「歌曲 <ref>」
    assert.equal(deriveQQTitle('https://c6.y.qq.com/base/fcgi-bin/u?__=AbCdEf'), '')
    assert.equal(deriveQQTitle('12345'), '')
    assert.equal(deriveQQTitle(''), '')
    assert.equal(deriveQQTitle(undefined), '')
    assert.equal(deriveQQTitle('https://y.qq.com/n/ryqq/songDetail/0041nxUx2Oy8rD'), '')
})

test('F4-8 导入用 deriveQQTitle，不再恒写 title:""', () => {
    const qq = src('../js/qq-music.js')
    assert.match(qq, /title:\s*deriveQQTitle\(raw\)/, 'addQQTrack 必须带上解析出的歌名')
    assert.equal(/title:\s*''\s*\}/.test(qq), false, '不该再有无条件的空 title')
})

test('parseQQLink 的 embedUrl 模板保持原样（未加 auto=0，改的是 autoplay 授权）', () => {
    assert.equal(
        parseQQLink('https://c6.y.qq.com/base/fcgi-bin/u?__=abc_123').embedUrl,
        'https://i.y.qq.com/n2/m/outchain/player/index.html?shorttag=abc_123')
    assert.equal(parseQQLink('https://y.qq.com/n/ryqq/songDetail/0041nxUx2Oy8rD').embedUrl, null)
})

// ── F4-8a：renderLibrary 的并发序号 ──────────────────────────────────

const makeHost = () => {
    const writes = { count: 0, list: 0, empty: 0 }
    const mk = key => ({
        set textContent (v) { writes[key]++ },
        get textContent () { return '' },
        hidden: false,
        replaceChildren () { writes.list++ },
    })
    const els = { '#qq-lib-list': mk('list'), '#qq-lib-empty': mk('empty'), '#qq-lib-count': mk('count') }
    return { writes, host: { querySelector: s => els[s] || null } }
}

test('F4-8 renderLibrary 有并发序号：被取代的那一次不得写 DOM', async () => {
    const panel = new QQMusicPanel({
        settings: { music: { qqLink: null } }, player: { stop () {} }, persist () {},
        onToast () {}, onEmbed () {}, getLiveHost: () => null, onDock () {},
    })
    const { writes, host } = makeHost()
    panel.host = host
    assert.equal(panel._libToken, 0, '初始序号应为 0')
    // 两次都发起、都不等待：A 的结果一定后于 B 领取序号，因此 A 必须整段作废
    const a = panel.renderLibrary()
    const b = panel.renderLibrary()
    await Promise.allSettled([a, b])
    await sleep(10)
    assert.equal(panel._libToken, 2, '每次调用都应领取一个新序号')
    assert.equal(writes.list, 1,
        `列表只应被最新那一次写入，实际写了 ${writes.list} 次——旧快照会覆盖导入/删除的结果`)
    assert.equal(writes.count, 1, `计数只应写一次，实际 ${writes.count} 次`)
})

test('F4-8 序号在 await 之前领取、在写 DOM 之前校验', () => {
    const qq = src('../js/qq-music.js')
    const body = qq.slice(qq.indexOf('async renderLibrary()'), qq.indexOf('// 点一下重播'))
    // 先确认截到了完整方法：边界一旦移动把 catch 分支切掉，上面的判定就会假通过
    assert.ok(body.includes('catch(error)') && body.includes('replaceChildren'), '没能截到 renderLibrary 全文')
    const claim = body.indexOf('const token=++this._libToken')
    const awaited = body.indexOf('await listQQTracks()')
    const guard = body.indexOf('if(token!==this._libToken)return')
    assert.ok(claim > 0 && awaited > 0 && guard > 0, '缺少序号领取/校验')
    assert.ok(claim < awaited, '序号必须在 await 之前领取')
    assert.ok(guard > awaited, '序号必须在校验之后才写 DOM')
    assert.equal(body.split('if(token!==this._libToken)return').length - 1, 2,
        '成功分支和失败分支都要校验，否则过期的一次仍会覆盖')
})

// ── F4-9：官方控件 iframe 不再拿到 autoplay 许可 ──────────────────────

test('F4-9 两处官方播放器 iframe 都不再授 allow="autoplay"', () => {
    const qq = src('../js/qq-music.js')
    const ui = src('../js/music-ui.js')
    assert.equal(/\.allow\s*=\s*'autoplay'/.test(qq), false, 'QQ iframe 不该再拿到 autoplay 许可')
    assert.equal(/\.allow\s*=\s*'autoplay'/.test(ui), false, '网易云 iframe 同上，两侧口径一致')
    assert.equal(/allow="autoplay"/.test(qq + ui), false)
    // 网易云模板仍显式 auto=0
    assert.match(ui, /buildPlayerUrl/, '网易云 src 仍由白名单模板拼出')
    const music = src('../js/music.js')
    assert.match(music, /&auto=0/, '网易云外链模板保留 auto=0')
    // 文案仍指向「请在官方控件里点播放」，与实际行为一致
    assert.match(qq, /请在官方控件里点播放|请在其中点播放/)
})
