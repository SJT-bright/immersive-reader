// 已保存歌曲的本地存取由 db.js 提供（IndexedDB，url 去重）。
import { addQQTrack, listQQTracks, deleteQQTrack, touchQQTrack } from './db.js'

// Verified against https://y.qq.com/m/outchain/player/index.2ee216446.js
// The official player accepts numeric songid or a share-link shorttag, not songmid.
export function parseQQLink(input) {
    try {
        const text=String(input||'').trim()
        if (/[<>]/.test(text)) throw new Error()
        const raw=text.match(/https?:\/\/[^\s，。；「」“”]+/)?.[0]
        const u=new URL(raw || (/^\d{1,15}$/.test(text)?`https://y.qq.com/n/ryqq/songDetail/${text}`:text))
        if(u.protocol!=='https:'&&u.protocol!=='http:' || u.username || u.password || u.port || !['y.qq.com','i.y.qq.com','c.y.qq.com','c6.y.qq.com'].includes(u.hostname)) throw new Error()
        let kind='song',key,id
        if(u.pathname==='/base/fcgi-bin/u') {key='shorttag';id=u.searchParams.get('__')}
        else if(u.pathname==='/n2/m/outchain/player/index.html') {
            key=u.searchParams.has('shorttag')?'shorttag':'songid';id=u.searchParams.get(key)
        } else {
            const match=u.pathname.match(/^\/(?:n\/ryqq\/|n\/yqq\/)(songDetail|song|playlist|albumDetail|album)\/([a-zA-Z0-9]+)(?:\.html)?\/?$/)
            if(match){kind=match[1].startsWith('album')?'album':match[1]==='playlist'?'playlist':'song';id=match[2];key=/^\d+$/.test(id)?'songid':'songmid'}
            else if(/^\/(?:v8\/playsong\.html|n2\/m\/share\/details\/[^/]+\.html)$/.test(u.pathname)) {
                id=u.searchParams.get('songid')||u.searchParams.get('songmid');key=u.searchParams.has('songid')?'songid':'songmid'
            } else throw new Error()
        }
        if(!id || (key==='songid'?!/^\d{1,15}$/.test(id):! /^[a-zA-Z0-9_-]{1,80}$/.test(id)))throw new Error()
        const url=key==='shorttag'?`https://c.y.qq.com/base/fcgi-bin/u?__=${id}`:`https://y.qq.com/n/ryqq/${kind==='album'?'albumDetail':kind==='playlist'?'playlist':'songDetail'}/${id}`
        const embedUrl=kind==='song'&&key!=='songmid'?`https://i.y.qq.com/n2/m/outchain/player/index.html?${key}=${id}`:null
        return {ok:true,kind,key,id,url,embedUrl}
    } catch {return {ok:false,reason:'请粘贴 QQ 音乐官方歌曲分享链接、歌单链接或数字歌曲 ID'}}
}

// 从粘贴的分享文本里取歌名。QQ 音乐分享语常见形式：
//   「《晴天》 https://c6.y.qq.com/base/fcgi-bin/u?__=AbCdEf」
//   「我在QQ音乐分享了歌曲《晴天》 点击链接」
// parseQQLink 只解析链接本身、不发网络请求，也拿不到任何标题；纯链接或纯数字 ID 里
// 本来就没有歌名信息，此时只能返回空串，由列表回退显示「歌曲 <ref>」。
export function deriveQQTitle (input) {
    const text = String(input || '')
    const book = text.match(/[《〈]\s*([^》〉\n]{1,80})[》〉]/)
    if (book) return book[1].trim()
    const quoted = text.match(/["']([^"'\n]{1,80})["']/)
    if (quoted) return quoted[1].trim()
    return ''
}

export class QQMusicPanel {
    constructor({settings,player,persist,onToast,onEmbed,getLiveHost,onDock}) {
        // _libToken：renderLibrary 的并发序号。mount() 会先发一次（等 IndexedDB），
        // 用户在此之前点「导入链接」会再发一次；没有序号时先发的旧快照会覆盖后写的列表，
        // 已删条目复活、#qq-lib-count 与实际不符、点「重播」落到已删除项。
        Object.assign(this,{settings,player,persist,onToast,onEmbed,getLiveHost,onDock});this.mounted=false;this._libToken=0
    }
    mount(host) {
        this.host=host
        host.innerHTML=`<section><h3>QQ 音乐</h3><div class="row"><input id="qq-input" type="text" aria-label="QQ音乐链接" placeholder="粘贴 QQ 音乐分享链接"><button id="qq-import" class="primary">导入链接</button></div><p class="hint">歌曲分享短链或数字 ID 可使用官方播放器；普通歌曲详情、歌单和专辑链接提供官方打开入口。画面里的播放器与这里是同一路。</p><details id="qq-library" class="qq-library"><summary><span>已保存的歌曲</span><output id="qq-lib-count">0</output></summary><ul id="qq-lib-list" aria-label="已保存的 QQ 歌曲"></ul><p id="qq-lib-empty" class="hint">还没有保存的歌曲。导入链接后会自动留在这里，以后点一下就能听。</p></details><div id="qq-player" class="live-slot" data-live="qq"></div><div class="row"><label for="qq-system-volume">电脑音量</label><input id="qq-system-volume" type="range" min="0" max="100" step="1" value="0" disabled aria-label="电脑音量"><span id="qq-volume-value">—</span><button id="qq-system-mute" disabled>静音</button><button id="qq-volume-refresh">刷新音量</button></div><p id="qq-volume-status" class="hint" role="status">正在读取电脑音量…</p><p class="hint">调节 Mac 的整体输出音量，也影响其他应用。若仍无声，请检查浏览器标签页是否静音，以及系统声音输出是否选中了耳机或音箱。</p><div class="row"><button id="qq-play" hidden>加载官方播放器</button><a id="qq-open" target="_blank" rel="noopener noreferrer" hidden>在 QQ 音乐打开 ↗</a><button id="qq-remove" hidden>移除链接</button></div><p id="qq-status" class="hint" role="status"></p><p class="hint">官方播放器只有一份，会出现在画面底部或本页槽位。请在其中点播放。可播范围由 QQ 音乐决定。</p></section>`
        host.querySelector('#qq-input').value=this.settings.music.qqLink||''
        host.querySelector('#qq-import').onclick=async()=>{
            const raw=host.querySelector('#qq-input').value
            const info=parseQQLink(raw)
            if(!info.ok){this.onToast(info.reason);return}
            // 先入库再激活链接：激活后「已保存的歌曲」里立刻能看到这首；
            // 保存失败（如存储不可用）仍不阻断本次播放，但提示先于播放出现
            try {await addQQTrack({url:info.url,kind:info.kind,key:info.key,ref:info.id,title:deriveQQTitle(raw)})}
            catch(error) {this.onToast(`歌曲未能保存：${error?.message||error}`)}
            this.settings.music.qqLink=info.url;this.persist();this.unmount();this.update()
            this.renderLibrary()
            if(info.embedUrl)this.embed()
        }
        host.querySelector('#qq-play').onclick=()=>this.embed()
        host.querySelector('#qq-remove').onclick=()=>{this.unmount();this.settings.music.qqLink=null;this.persist();this.update()}
        host.querySelector('#qq-open').onclick=()=>{this.player.stop();this.onEmbed();this.unmount()}
        const slider=host.querySelector('#qq-system-volume')
        slider.oninput=()=>{host.querySelector('#qq-volume-value').textContent=slider.value+'%'}
        slider.onchange=()=>this.systemVolume({volume:Number(slider.value),muted:false})
        host.querySelector('#qq-system-mute').onclick=()=>this.systemVolume({volume:this.systemSound.volume,muted:!this.systemSound.muted})
        host.querySelector('#qq-volume-refresh').onclick=()=>this.systemVolume()
        this.systemVolume();this.update();this.renderLibrary()
    }
    // 折叠歌单：读取 db 渲染列表；读取失败时降级为提示，不影响播放。
    async renderLibrary() {
        const get=s=>this.host?.querySelector(s),list=get('#qq-lib-list'),empty=get('#qq-lib-empty'),count=get('#qq-lib-count')
        if(!list||!empty||!count)return
        const token=++this._libToken          // await 之前领取序号
        try {
            const tracks=await listQQTracks()
            // 有更晚的一次调用在写（或即将写）：这份快照已经过期，整段丢弃，
            // 否则它会把期间导入/删除的结果覆盖回旧样子。
            if(token!==this._libToken)return
            count.textContent=String(tracks.length);empty.hidden=tracks.length>0
            if(!tracks.length)empty.textContent='还没有保存的歌曲。导入链接后会自动留在这里，以后点一下就能听。'
            list.replaceChildren(...tracks.map(track=>{
                const li=document.createElement('li'),name=track.title||`歌曲 ${track.ref}`
                const play=document.createElement('button');play.type='button';play.className='play'
                play.dataset.url=track.url;play.title=name
                play.classList.toggle('on',this.settings.music.qqLink===track.url)
                play.onclick=()=>this.playSaved(track)
                const nm=document.createElement('span');nm.className='nm';nm.textContent=name
                const sub=document.createElement('span');sub.className='sub'
                const day=new Date(track.addedAt);sub.textContent=isNaN(day)?'':day.toLocaleDateString('zh-CN')
                play.replaceChildren(nm,sub)
                const del=document.createElement('button');del.type='button';del.className='del';del.textContent='✕'
                del.title='删除';del.setAttribute('aria-label',`删除已保存的 ${name}`)
                del.onclick=async()=>{
                    if(!confirm(`删除已保存的「${name}」？`))return
                    try {await deleteQQTrack(track.id);this.renderLibrary()}
                    catch(error) {this.onToast(`删除失败：${error?.message||error}`)}
                }
                li.replaceChildren(play,del)
                return li
            }))
        } catch(error) {
            if(token!==this._libToken)return
            count.textContent='';list.replaceChildren();empty.hidden=false
            empty.textContent='歌曲列表暂时无法读取'
        }
    }
    // 点一下重播：写回当前链接、同步高亮，能内嵌就直接加载官方播放器。
    async playSaved(track) {
        this.settings.music.qqLink=track.url;this.persist()
        this.host.querySelector('#qq-input').value=track.url;this.update()
        this.host.querySelectorAll('#qq-lib-list .play').forEach(b=>b.classList.toggle('on',b.dataset.url===track.url))
        try {await touchQQTrack(track.id)} catch { /* 最近播放时间仅作统计，失败可忽略 */ }
        const info=parseQQLink(track.url)
        if(info.embedUrl)this.embed()
        else this.onToast('此链接不支持内嵌播放，请用「在 QQ 音乐打开」')
    }
    async systemVolume(value) {
        const get=s=>this.host.querySelector(s)
        get('#qq-system-volume').disabled=true;get('#qq-system-mute').disabled=true;get('#qq-volume-refresh').disabled=true
        try {
            const response=await fetch('/_reader/volume',value?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:undefined)
            const state=await response.json()
            if(!response.ok)throw new Error(state.error||'请使用电脑音量键调节')
            this.systemSound=state
            get('#qq-system-volume').value=state.volume
            get('#qq-volume-value').textContent=state.volume+'%'
            get('#qq-system-mute').textContent=state.muted?'取消静音':'静音'
            get('#qq-system-mute').setAttribute('aria-pressed',String(state.muted))
            get('#qq-volume-status').textContent=state.muted?'电脑目前已静音。':state.volume===0?'电脑音量为零，请调高音量。':'电脑未静音；此控制调节系统音量。'
            get('#qq-system-volume').disabled=false;get('#qq-system-mute').disabled=false
        } catch(error) {get('#qq-volume-status').textContent='无法连接电脑音量控制，请用项目的 start.command 启动，或使用系统音量键。'}
        finally {get('#qq-volume-refresh').disabled=false}
    }
    update() {
        if(!this.host)return
        const info=parseQQLink(this.settings.music.qqLink),get=s=>this.host.querySelector(s)
        get('#qq-open').hidden=!info.ok
        if(info.ok)get('#qq-open').href=info.url;else get('#qq-open').removeAttribute('href')
        get('#qq-remove').hidden=!info.ok
        get('#qq-play').hidden=!info.embedUrl||this.mounted
        get('#qq-status').textContent=this.mounted?'官方播放器已打开，与画面是同一路。请在其中点播放；若空白或无法播放，请使用官方打开入口。':info.ok?(info.embedUrl?'链接已保存，点击加载官方播放器。':'链接已保存，可在 QQ 音乐打开；此链接不能直接嵌入歌曲播放器。'):'尚未导入 QQ 音乐链接。'
        const slot=get('#qq-player')
        if(slot){
            slot.style.minHeight=this.mounted?'100px':''
            slot.classList.toggle('on', this.mounted)
        }
    }
    embed() {
        const info=parseQQLink(this.settings.music.qqLink)
        const live=this.getLiveHost?.()
        if(!info.embedUrl||!live)return
        this.player.stop();this.onEmbed()
        let frame=live.querySelector('iframe')
        if(!frame||frame.getAttribute('src')!==info.embedUrl){
            frame=document.createElement('iframe')
            frame.src=info.embedUrl
            frame.title='QQ音乐官方外链播放器'
            // 不再授 allow='autoplay'：外链模板不带 auto=0，是否「加载即播」由第三方页面默认值决定，
            // 授了权限就可能无手势出声，和两处「请在官方控件里点播放」的说法冲突。
            // 收掉权限后，官方控件里的播放按钮走用户手势，照常可播，只是不会再自己响起来。
            frame.dataset.source='qq'
            live.replaceChildren(frame)
        }
        live.hidden=false
        this.mounted=true
        this.update()
        this.onDock?.()
    }
    unmount() {
        const live=this.getLiveHost?.()
        if(live?.querySelector('iframe[data-source="qq"]')) live.replaceChildren()
        this.mounted=false
        this.update()
        this.onDock?.()
    }
}
