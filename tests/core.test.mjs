import test from 'node:test'
import assert from 'node:assert/strict'
import { parseNeteaseLink, buildPlayerUrl, formatTime, shuffleIds, defaultArtwork, musicSurface } from '../js/music.js'
import { normalizeSettings, DEFAULT_SETTINGS } from '../js/settings.js'
import { safeAlpha, verifyContrast, TEXT_THEMES, coverSourceRect } from '../js/readability.js'
import { decodeBackup, blobToBase64, digest } from '../js/backup.js'
import { splitChapters, txtToEpubBlob } from '../js/txt2epub.js?v=1.5.0'

test('NetEase accepts known routes and rejects domain, credentials, HTML and invalid IDs', () => {
    for (const [url, type] of [
        ['https://music.163.com/#/song?id=186016',2],
        ['https://music.163.com/playlist?id=3778678',0],
        ['https://music.163.com/album?id=32311',1],
        ['https://music.163.com/outchain/1/32311/',1],
    ]) { const r = parseNeteaseLink(url); assert.equal(r.ok,true); assert.equal(r.type,type); assert.match(buildPlayerUrl(r),/^https:\/\/music.163.com\/outchain\/player\?/); }
    for (const url of ['javascript:alert(1)','https://evil.test/song?id=186016','https://music.163.com.evil.test/song?id=186016',
        'https://user:pass@music.163.com/song?id=186016','https://music.163.com:1234/song?id=186016',
        '<iframe src="https://music.163.com"></iframe>','https://music.163.com/song?id=x',
        'https://music.163.com/outchain/8/123456789012345678901/']) assert.equal(parseNeteaseLink(url).ok,false,url)
})
test('untrusted nested settings normalize without modifying defaults', () => {
    const before = JSON.stringify(DEFAULT_SETTINGS)
    const invalid = normalizeSettings({layout:null,background:{slotMap:null,rotateMinutes:-2},music:{volume:Infinity,netease:{id:'bad',type:2}},readability:{theme:'nope',maskBias:-99}})
    assert.equal(invalid.layout.fontSize,21)
    assert.equal(invalid.background.rotateMinutes,1)
    assert.equal(invalid.readability.maskBias,-1)
    assert.equal(invalid.music.netease,null)
    assert.equal(normalizeSettings({music:{netease:{type:8,id:'32311',kind:'album'}}}).music.netease.type,1)
    invalid.background.slotMap.morning='changed'
    assert.equal(JSON.stringify(DEFAULT_SETTINGS),before)
})
test('contrast floor passes every RGB cube sample and arbitrary fade mixtures', () => {
    for (const [theme, colors] of Object.entries(TEXT_THEMES)) {
        const plan={textColor:colors.color,maskColor:colors.maskColor,maskAlpha:safeAlpha(theme)}
        for(let r=0;r<=255;r+=15) for(let g=0;g<=255;g+=15) for(let b=0;b<=255;b+=15) assert.ok(verifyContrast(plan,[r,g,b])>=4.5,`${theme}: ${r},${g},${b}`)
        for(let t=0;t<=1;t+=0.01) assert.ok(verifyContrast(plan,[255*t,255*(1-t),127])>=4.5)
    }
})
test('cover mapping samples the displayed center crop', () => {
    assert.deepEqual(coverSourceRect({width:2000,height:1000},1000,1000,{x:250,y:100,width:500,height:800}),{sx:750,sy:100,sw:500,sh:800})
})
test('TXT escapes markup, retains chapter boundaries and emits EPUB ZIP', async () => {
    const text='第一章 花园\n\n<script>not executable</script>\n\n第二章 草原\n\n你好。'
    assert.equal(splitChapters(text).length,2)
    const blob=await txtToEpubBlob(text,'Test'), body=await blob.text()
    assert.match(body,/&lt;script&gt;not executable/)
    assert.equal(new Uint8Array(await blob.slice(0,2).arrayBuffer()).join(','),'80,75')
})
const payload = async () => {
    const b = new Blob(['RIFF-test-audio'],{type:'audio/wav'})
    return {app:'immersive-reader',version:2,settings:normalizeSettings(null),data:{books:[],backgrounds:[],audio:[{id:'audio-test',name:'tone.wav',data:await blobToBase64(b),mime:b.type,byteLength:b.size,sha256:await digest(b)}]}}
}
test('backup validates bytes, preserves MIME, rejects corrupt content before writes', async () => {
    const p=await payload(), decoded=await decodeBackup(p)
    assert.equal(decoded.data.audio[0].data.type,'audio/wav')
    assert.equal(await decoded.data.audio[0].data.text(),'RIFF-test-audio')
    p.data.audio[0].data=await blobToBase64(new Blob(['CORRUPTED']))
    await assert.rejects(decodeBackup(p),/校验失败/)
})
test('incomplete or duplicate backup cannot silently clear current library', async () => {
    const p=await payload()
    delete p.data.books
    await assert.rejects(decodeBackup(p),/缺少 books/)
    const q=await payload();q.data.audio.push(q.data.audio[0])
    await assert.rejects(decodeBackup(q),/重复/)
})
test('legacy v1 backup recovers common audio MIME without changing bytes', async () => {
    const p=await payload();p.version=1;delete p.data.audio[0].mime
    const decoded=await decodeBackup(p)
    assert.equal(decoded.data.audio[0].data.type,'audio/wav')
})
test('mini player and side panel share one music surface', () => {
    assert.deepEqual(musicSurface({ localPlaying: true, localCount: 2, qqMounted: true }),
        { source: 'local', showLocalMini: true, showRemote: false })
    assert.deepEqual(musicSurface({ localPlaying: false, localCount: 2, qqMounted: true }),
        { source: 'qq', showLocalMini: false, showRemote: true })
    assert.deepEqual(musicSurface({ localPlaying: false, localCount: 2, neteaseMounted: true }),
        { source: 'netease', showLocalMini: false, showRemote: true })
    assert.deepEqual(musicSurface({ localCount: 1 }),
        { source: 'local', showLocalMini: true, showRemote: false })
    assert.deepEqual(musicSurface({}),
        { source: 'local', showLocalMini: false, showRemote: false })
})
test('playback time formats hours and clamps invalid input', () => {
    assert.equal(formatTime(0),'0:00')
    assert.equal(formatTime(9.6),'0:09')
    assert.equal(formatTime(65),'1:05')
    assert.equal(formatTime(3725),'1:02:05')
    assert.equal(formatTime(NaN),'0:00')
    assert.equal(formatTime(-4),'0:00')
    assert.equal(formatTime(Infinity),'0:00')
})
test('shuffle keeps every id exactly once and pins the current track first', () => {
    const ids=['a','b','c','d','e','f','g','h']
    for (let i=0;i<200;i++) {
        const out=shuffleIds(ids,'d')
        assert.equal(out.length,ids.length)
        assert.deepEqual([...out].sort(),[...ids].sort(),'随机后曲目集合改变')
        assert.equal(out[0],'d','当前曲目未被固定在最前')
    }
    assert.deepEqual(shuffleIds([],'x'),[])
    assert.deepEqual(shuffleIds(['only']),['only'])
})
test('music settings normalize unknown values and keep order ids unique', () => {
    const s=normalizeSettings({music:{volume:'loud',muted:1,playMode:'bogus',fadeMs:777,tab:'lyrics',lastTrackId:'bad id!',order:['a','a','b',42,'c']}})
    assert.equal(s.music.volume,0.8)
    assert.equal(s.music.muted,false)
    assert.equal(s.music.playMode,'repeatAll','非法播放模式未回退列表循环')
    assert.equal(s.music.fadeMs,1000,'非法淡入淡出档位未回退默认 1 秒')
    assert.equal(s.music.tab,'local')
    assert.equal(s.music.lastTrackId,null)
    assert.deepEqual(s.music.order,['a','b','c'])
    const good=normalizeSettings({music:{playMode:'shuffle',fadeMs:2000,tab:'netease',lastTrackId:'track-1',order:['x','y']}})
    assert.equal(good.music.playMode,'shuffle')
    assert.equal(good.music.fadeMs,2000)
    assert.equal(good.music.tab,'netease')
    assert.equal(good.music.lastTrackId,'track-1')
    assert.deepEqual(good.music.order,['x','y'])
})
test('legacy music settings migrate to playMode and fadeMs', () => {
    // 旧版 loop+shuffle 布尔组合 → 播放模式四态（QQ 音乐口径）
    assert.equal(normalizeSettings({music:{shuffle:true}}).music.playMode,'shuffle','shuffle:true 未迁移为随机播放')
    assert.equal(normalizeSettings({music:{loop:'one'}}).music.playMode,'repeatOne','loop:one 未迁移为单曲循环')
    assert.equal(normalizeSettings({music:{loop:'none'}}).music.playMode,'sequential','loop:none 未迁移为顺序播放')
    assert.equal(normalizeSettings({music:{}}).music.playMode,'repeatAll','默认未回退列表循环')
    assert.equal(normalizeSettings({music:{shuffle:false,loop:'all'}}).music.playMode,'repeatAll','loop:all 未回退列表循环')
    // 旧版布尔 fade → 淡入淡出档位
    assert.equal(normalizeSettings({music:{fade:false}}).music.fadeMs,0,'fade:false 未迁移为关闭')
    assert.equal(normalizeSettings({music:{fade:true}}).music.fadeMs,1000,'fade:true 未迁移为 1 秒')
    // 显式新字段优先于旧字段
    assert.equal(normalizeSettings({music:{playMode:'sequential',shuffle:true}}).music.playMode,'sequential','playMode 应优先于旧 shuffle 字段')
    assert.equal(normalizeSettings({music:{fadeMs:500,fade:false}}).music.fadeMs,500,'fadeMs 应优先于旧 fade 字段')
})
test('default artwork degrades to null without a DOM', () => {
    assert.equal(typeof document,'undefined','Node 环境不应有 document')
    assert.equal(defaultArtwork(),null)
})

test('rain preferences are bounded and older preferences retain their selected background', () => {
    const defaults = normalizeSettings(null)
    assert.equal(defaults.background.fixedId, 'builtin:fluid')
    assert.equal(defaults.background.mode, 'fixed')
    const old = normalizeSettings({background:{mode:'fixed',fixedId:'my-saved-picture'}})
    assert.equal(old.background.fixedId, 'my-saved-picture')
    const a = normalizeSettings({atmosphere:{rain:9,fog:-1,refraction:NaN,motion:false,enabled:false}}).atmosphere
    assert.deepEqual(a, {
        rain:1,snow:.62,snowDepth:.65,fog:0,refraction:1.33,motion:false,enabled:false,weather:'rain',
        wind:.25,lightning:false,sceneFx:true,
        dropSize:1,fallSpeed:1,trail:1,flowSpeed:1,brightness:1,warmth:0,parallax:1,paperOpacity:1,lightningEvery:.35,
    })
    assert.equal(normalizeSettings({atmosphere:{weather:'snow',snow:9}}).atmosphere.weather,'snow')
    assert.equal(normalizeSettings({atmosphere:{weather:'snow',snow:9}}).atmosphere.snow,1)
    assert.equal(normalizeSettings({atmosphere:{snowDepth:9}}).atmosphere.snowDepth,1)
    assert.equal(normalizeSettings({atmosphere:{weather:'storm'}}).atmosphere.weather,'rain')
    const bounded = normalizeSettings({atmosphere:{wind:7},ambience:{enabled:true,kind:'hacker',volume:3,thunder:'x'},readaloud:{rate:9}})
    assert.equal(bounded.atmosphere.wind, 1)
    assert.deepEqual(bounded.ambience, {enabled:true,kind:'rain',volume:1,thunder:true})
    assert.equal('readaloud' in bounded, false) // 旧备份中的已移除功能不再恢复
})
test('video cover uses decoded dimensions instead of an unset element width', () => {
    assert.deepEqual(coverSourceRect({videoWidth:2000,videoHeight:1000,width:0,height:0},1000,1000,{x:250,y:100,width:500,height:800}),{sx:750,sy:100,sw:500,sh:800})
})
test('video background survives a portable backup with original MIME and bytes', async () => {
    const p=await payload(),blob=new Blob(['video fixture bytes'],{type:'video/mp4'})
    p.data.backgrounds=[{id:'video-scene',name:'窗外',data:await blobToBase64(blob),mime:blob.type,byteLength:blob.size,sha256:await digest(blob)}]
    const decoded=await decodeBackup(p)
    assert.equal(decoded.data.backgrounds[0].data.type,'video/mp4')
    assert.equal(await decoded.data.backgrounds[0].data.text(),'video fixture bytes')
})


test('QQ links use only official hosts and supported player parameters', async()=>{
 const {parseQQLink}=await import('../js/qq-music.js')
 assert.equal(parseQQLink('https://c.y.qq.com/base/fcgi-bin/u?__=abc_123').embedUrl,'https://i.y.qq.com/n2/m/outchain/player/index.html?shorttag=abc_123')
 assert.equal(parseQQLink('https://y.qq.com/n/ryqq/songDetail/12345').key,'songid')
 assert.equal(parseQQLink('https://y.qq.com/n/ryqq/songDetail/0041nxUx2Oy8rD').embedUrl,null)
 assert.equal(parseQQLink('https://y.qq.com/n/ryqq/playlist/12345').embedUrl,null)
 for(const value of ['https://y.qq.com.evil.test/n/ryqq/songDetail/123','https://user@y.qq.com/n/ryqq/songDetail/123','javascript:alert(1)','<iframe src="https://y.qq.com">','https://y.qq.com:9999/n/ryqq/songDetail/1'])assert.equal(parseQQLink(value).ok,false)
})
test('auto reading and QQ preferences normalize safely',()=>{
 const s=normalizeSettings({autoRead:{mode:'evil',pixelsPerSecond:999,pageSeconds:-1},music:{tab:'qq',qqLink:'https://c.y.qq.com/base/fcgi-bin/u?__=abc'}})
 assert.deepEqual(s.autoRead,{flow:'paginated',mode:'scroll',pixelsPerSecond:80,pageSeconds:5,endDwellSeconds:8})
 assert.equal(s.music.tab,'qq');assert.ok(s.music.qqLink.includes('__=abc'))
 assert.equal(normalizeSettings({music:{qqLink:'https://evil.test'}}).music.qqLink,null)
})

test('portable backup retains book quotes, comments and bookmarks and rejects broken anchors', async()=>{
    const p=await payload(),blob=await txtToEpubBlob('第一章\n这是读书笔记测试。','Notes')
    const notes=[{id:'note-1',type:'quote',cfi:'epubcfi(/6/2!/4/2/1:0)',text:'测试摘录',after:'下一句。',comment:'自己的想法',chapter:'第一章',page:'3',location:'',createdAt:1},{id:'mark-1',type:'bookmark',cfi:'epubcfi(/6/2!/4/2)',text:'第一章',after:'',comment:'',chapter:'第一章',page:'',location:'',createdAt:2}]
    p.data.books=[{id:'book-notes',title:'Notes',author:'',format:'epub',data:await blobToBase64(blob),mime:blob.type,byteLength:blob.size,sha256:await digest(blob),notes}]
    // normalizeNote 会补 editedAt（缺省回落 createdAt），合并与撤销靠它判断新旧
    assert.deepEqual((await decodeBackup(p)).data.books[0].notes,notes.map(n=>({...n,editedAt:n.createdAt})))
    assert.equal((await decodeBackup(p)).data.books[0].notes[0].after,'下一句。')
    p.data.books[0].notes[0].cfi='javascript:bad'
    await assert.rejects(decodeBackup(p),/笔记或书签格式损坏/)
})

test('QQ song links persist through backup under host whitelist and legacy backups fall back to empty', async()=>{
    const {normalizeQQTracks}=await import('../js/backup.js')
    const track={id:'qq-track-1',url:'https://c.y.qq.com/base/fcgi-bin/u?__=abc_123',kind:'song',key:'shorttag',ref:'https://y.qq.com/n/ryqq/songDetail/12345',title:'测试曲',addedAt:1,lastPlayedAt:2}
    const withQQ=async(qqTracks,version=2)=>{const p=await payload();p.version=version;p.data.qqTracks=qqTracks;return decodeBackup(p)}
    // 合法曲目整条保留，且 normalizeQQTracks 之外的字段不会进入恢复结果
    assert.deepEqual((await withQQ([{...track,extra:'dropped'}])).data.qqTracks,[track])
    // V1 旧备份没有 qqTracks 字段时默认空数组，保持兼容
    assert.deepEqual((await decodeBackup(await payload())).data.qqTracks,[])
    const v1=await payload();v1.version=1
    assert.deepEqual((await decodeBackup(v1)).data.qqTracks,[])
    assert.deepEqual(normalizeQQTracks(undefined),[])
    // 非法输入整包拒绝，绝不静默丢弃
    for(const bad of [
        {...track,url:'https://evil.test/x'},
        {...track,url:'https://y.qq.com.evil.test/x'},
        {...track,url:'ftp://y.qq.com/x'},
        {...track,url:'https://y.qq.com/x?_='+'y'.repeat(500)},
        {...track,url:12},
        {...track,kind:'hacker'},
        {...track,key:'session'},
        {...track,ref:'r'.repeat(81)},
        {...track,id:'bad id!'},
    ]) await assert.rejects(withQQ([bad]),/无效|缺失|编号/,JSON.stringify(bad))
    await assert.rejects(withQQ('nope'),/列表无效/)
    await assert.rejects(withQQ([track,{...track,id:'qq-track-1'}]),/重复/)
    // 规范化输出：未知标题与时间戳安全回退
    assert.deepEqual(normalizeQQTracks([{...track,title:9,addedAt:'x',lastPlayedAt:null}]),
        [{...track,title:'',addedAt:0,lastPlayedAt:0}])
})
