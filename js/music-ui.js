import { QQMusicPanel } from './qq-music.js?v=1.6.1'
// 音乐 UI：左下角唱机（把手放到唱片上播放）+ 音乐面板。
//
// 设计前提：音乐是阅读的氛围，不是主角。画面唱机与右侧面板是同一路播放，
// 本地 / QQ / 网易云同时只出声一路。官方播放器挂在面板外的 #live-player，
// 关面板不会因为 display:none 把声音掐掉。
//
// 本模块负责 DOM 与用户交互，本地播放委托 music.js 的 LocalAudioPlayer；
// 需要读写 IndexedDB 的动作（导入/删除/改名/排序）通过 onAction 回调交给 main.js。

import { icon } from './icons.js'
import { formatTime, clamp, buildPlayerUrl, buildOpenUrl, neteaseEmbedHeight, musicSurface } from './music.js?v=1.6.0'
import { DISC, REST, puckOnDisc, snapPuck, clampPuck, VinylMotion } from './vinyl-deck.js?v=2.2.0'

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

const LOOP_MODES = [
    { value: 'all', label: '列表循环', icon: 'repeat' },
    { value: 'one', label: '单曲循环', icon: 'repeatOne' },
    { value: 'none', label: '顺序播放', icon: 'repeat' },
]

const SLEEP_OPTIONS = [
    { value: 'off', label: '关闭' },
    { value: '15', label: '15 分钟后' },
    { value: '30', label: '30 分钟后' },
    { value: '45', label: '45 分钟后' },
    { value: '60', label: '60 分钟后' },
    { value: 'track', label: '播完本曲' },
]

export class MusicUI {
    constructor ({ player, settings, persist, onAction, onToast, onLayoutChange }) {
        this.player = player
        this.settings = settings
        this.persist = persist
        this.onAction = onAction || (() => {})
        this.onToast = onToast || (() => {})
        this.onLayoutChange = onLayoutChange || (() => {})

        this.qq = new QQMusicPanel({
            settings, player, persist, onToast: this.onToast,
            onEmbed: () => this.unmountNetease(false),
            getLiveHost: () => this.live,
            onDock: () => this.syncLiveDock(),
        })
        this.panelHost = null
        this.mini = null
        this.live = document.getElementById('live-player')
        this.neteaseInfo = null
        this.neteaseMounted = false
        this._dockKey = ''
        this.editingId = null
        this._seekDragging = false
        this._puckDragging = false
        this._trackSignature = ''
        this._sleepTicker = null
        this._lastState = player.getState()

        this._onState = () => this.update()
        player.addEventListener('state', this._onState)
        player.addEventListener('sleepdone', e => {
            this.onToast(e.detail?.reason === 'track' ? '睡眠定时：本曲已播完，已暂停' : '睡眠定时已到，音乐已暂停')
        })
        player.addEventListener('audioerror', e => {
            this.motion?.onAudio('error')
            this.onToast(e.detail || '未能播放')
        })
        // 兜底：指针抬起后一定解除"拖动中"，避免进度条卡住不再跟随播放推进
        this._releaseSeek = () => setTimeout(() => {
            if (this._seekDragging) { this._seekDragging = false; this.update() }
        }, 150)
        document.addEventListener('pointerup', this._releaseSeek)
        document.addEventListener('pointercancel', this._releaseSeek)
        this._onDock = () => this.syncLiveDock()
        window.addEventListener('resize', this._onDock)
        document.getElementById('panel')?.addEventListener('scroll', this._onDock, true)
        document.getElementById('music-panel-body')?.addEventListener('scroll', this._onDock)
    }

    // ---------- 唱机 ----------

    mountMiniPlayer (host) {
        const el = document.createElement('div')
        el.id = 'mini-player'
        el.className = 'vinyl-deck hidden'
        el.setAttribute('role', 'region')
        el.setAttribute('aria-label', '唱机：把中间的小轴放到唱片上播放')
        el.innerHTML = `
            <div class="deck-stage">
                <div class="deck-plinth" aria-hidden="true"></div>
                <div class="deck-platter">
                    <div class="deck-record">
                        <div class="deck-spin">
                            <canvas class="deck-grooves" width="512" height="512"></canvas>
                            <div class="deck-label">
                                <span class="deck-side">A</span>
                                <span class="deck-label-name"></span>
                            </div>
                        </div>
                        <div class="deck-sheen" aria-hidden="true"></div>
                        <div class="deck-spindle" aria-hidden="true"></div>
                    </div>
                </div>
                <div class="deck-rest" title="唱臂支架"></div>
                <div class="deck-pivot" aria-hidden="true"></div>
                <div class="deck-arm" aria-hidden="true">
                    <span class="deck-arm-tube"></span>
                    <span class="deck-arm-head"></span>
                    <span class="deck-arm-stylus"></span>
                </div>
                <button type="button" class="deck-puck" id="deck-puck" aria-label="唱机小轴：放到唱片上播放，拿开暂停" aria-pressed="false"></button>
                <p class="deck-hint" hidden></p>
            </div>
            <button type="button" class="deck-open" data-action="open-panel" aria-label="打开音乐面板">曲目</button>
            <div class="mp-title" id="mp-title">未在播放</div>`
        el.addEventListener('click', e => {
            const btn = e.target.closest('button[data-action]')
            if (btn) this.handleAction(btn.dataset.action, btn)
        })
        host.replaceChildren(el)
        this.mini = el
        this.motion?.destroy()
        this.motion = new VinylMotion({ stage: el.querySelector('.deck-stage'), player: this.player })
        this.bindPuck(el)
        this.setPuck(REST.x, REST.y, false)
    }

    setPuck (x, y, snap) {
        const el = this.mini
        if (!el) return
        const p = clampPuck(x, y)
        el.style.setProperty('--px', p.x + 'px')
        el.style.setProperty('--py', p.y + 'px')
        el.classList.toggle('puck-on', puckOnDisc(p.x, p.y))
        const puck = el.querySelector('#deck-puck')
        if (puck) {
            puck.style.left = p.x + 'px'
            puck.style.top = p.y + 'px'
            if (snap) puck.dataset.snap = '1'
            else delete puck.dataset.snap
        }
        return p
    }

    applyNeedle (x, y) {
        const on = puckOnDisc(x, y)
        const st = this.player.getState()
        if (on && !st.playing) this.player.play()
        if (!on && st.playing) this.player.pause()
        const puck = this.mini?.querySelector('#deck-puck')
        if (puck) puck.setAttribute('aria-pressed', String(on))
    }

    bindPuck (el) {
        const puck = el.querySelector('#deck-puck')
        if (!puck) return
        let grab = null
        const local = e => {
            const box = el.querySelector('.deck-stage').getBoundingClientRect()
            return { x: e.clientX - box.left, y: e.clientY - box.top }
        }
        puck.addEventListener('pointerdown', e => {
            if (e.button != null && e.button !== 0) return
            e.preventDefault()
            puck.setPointerCapture(e.pointerId)
            const at = local(e)
            const x = parseFloat(el.style.getPropertyValue('--px')) || REST.x
            const y = parseFloat(el.style.getPropertyValue('--py')) || REST.y
            grab = { dx: at.x - x, dy: at.y - y, sx: e.clientX, sy: e.clientY, dragged: false }
            this._puckDragging = true
            el.classList.add('dragging')
        })
        puck.addEventListener('pointermove', e => {
            if (!grab) return
            if (Math.hypot(e.clientX - grab.sx, e.clientY - grab.sy) > 5) grab.dragged = true
            const at = local(e)
            const p = this.setPuck(at.x - grab.dx, at.y - grab.dy, false)
            this.applyNeedle(p.x, p.y)
        })
        const end = e => {
            if (!grab) return
            const wasDrag = grab.dragged
            grab = null
            this._puckDragging = false
            el.classList.remove('dragging')
            if (!wasDrag) {
                const st = this.player.getState()
                const next = !st.playing
                this.setPuck(next ? DISC.x : REST.x, next ? DISC.y : REST.y, true)
                if (next) this.player.play()
                else this.player.pause()
                puck.setAttribute('aria-pressed', String(next))
                return
            }
            const at = local(e)
            const now = clampPuck(at.x, at.y)
            const snap = snapPuck(now.x, now.y)
            this.setPuck(snap.x, snap.y, true)
            this.applyNeedle(snap.x, snap.y)
        }
        puck.addEventListener('pointerup', end)
        puck.addEventListener('pointercancel', end)
        puck.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            const st = this.player.getState()
            const next = !st.playing
            this.setPuck(next ? DISC.x : REST.x, next ? DISC.y : REST.y, true)
            if (next) this.player.play()
            else this.player.pause()
        })
    }

    // ---------- 面板 ----------

    // 面板内容只构建一次；之后所有变化都由 update() 就地打补丁，
    // 这样拖动进度条、播放推进都不会打断交互或重建网易云 iframe。
    renderPanel (host) {
        if (this.panelHost === host && host.querySelector('.music-tabs')) { this.update(); return }
        this.panelHost = host
        host.innerHTML = `
            <div class="music-tabs" role="tablist">
                <button role="tab" data-tab="local">${icon('note')}<span>本地音乐</span></button>
                <button role="tab" data-tab="netease">${icon('music')}<span>网易云</span></button>
                <button role="tab" data-tab="qq"><span>QQ 音乐</span></button>
            </div>

            <div class="music-pane" data-pane="local">
                <div class="now-playing">
                    <div class="np-art" aria-hidden="true">${icon('note')}</div>
                    <div class="np-main">
                        <div class="np-title" id="np-title">未在播放</div>
                        <div class="np-sub" id="np-sub">导入音乐后即可开始</div>
                    </div>
                </div>

                <div class="seek-row">
                    <span class="t" id="np-time">0:00</span>
                    <input type="range" id="np-seek" min="0" max="1" step="0.1" value="0"
                           aria-label="播放进度" disabled>
                    <span class="t" id="np-dur">0:00</span>
                </div>

                <div class="np-controls">
                    <button data-action="shuffle" id="btn-shuffle" aria-pressed="false" title="随机播放">${icon('shuffle')}</button>
                    <button data-action="prev" aria-label="上一首" title="上一首">${icon('prev')}</button>
                    <button data-action="toggle" id="btn-toggle" class="main" aria-label="播放" title="播放 / 暂停">${icon('play')}</button>
                    <button data-action="next" aria-label="下一首" title="下一首">${icon('next')}</button>
                    <button data-action="loop" id="btn-loop" aria-pressed="false" title="循环方式">${icon('repeat')}</button>
                </div>

                <section>
                    <h3>音量</h3>
                    <div class="row">
                        <button data-action="mute" id="btn-mute" aria-pressed="false" title="静音">${icon('volume')}</button>
                        <input type="range" data-setting="volume" id="vol-range" min="0" max="1" step="0.01" aria-label="音量">
                        <span class="value" id="v-vol">80%</span>
                    </div>
                    <div class="row">
                        <label class="switch"><input type="checkbox" id="chk-fade"><span>播放 / 暂停时淡入淡出</span></label>
                    </div>
                </section>

                <section>
                    <h3>睡眠定时</h3>
                    <div class="row">
                        <select id="sel-sleep" aria-label="睡眠定时">
                            ${SLEEP_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}
                        </select>
                        <span class="value" id="sleep-status"></span>
                    </div>
                    <p class="hint">到点后自动暂停，不影响阅读位置。</p>
                </section>

                <section>
                    <h3>曲目 <span class="count" id="track-count"></span></h3>
                    <div class="row">
                        <button data-action="pick-audio" class="primary">${icon('plus')}<span>导入音频</span></button>
                    </div>
                    <ol class="track-list" id="track-list"></ol>
                    <p class="hint">支持浏览器可解码的 MP3 / WAV / OGG / M4A 等，单曲上限 200MB。拖动左侧手柄可调整顺序。</p>
                </section>
            </div>

            <div class="music-pane" data-pane="netease" hidden>
                <section>
                    <h3>网易云音乐</h3>
                    <div class="row">
                        <input type="text" id="netease-input" placeholder="粘贴单曲 / 歌单 / 专辑链接"
                               aria-label="网易云音乐链接">
                        <button data-action="netease-embed" class="primary">打开</button>
                    </div>
                    <p class="hint">粘贴官方链接后打开官方播放器。画面里出现的就是这一路，不会另开一套。</p>
                    <div id="netease-box" class="live-slot" data-live="netease"></div>
                    <div class="row" id="netease-actions"></div>
                    <p class="hint" id="netease-status"></p>
                </section>
                <p class="hint">画面底部与这里是同一个播放器。本地、QQ、网易云同时只听一路。</p>
            </div>
            <div class="music-pane" data-pane="qq" hidden><div id="qq-panel"></div></div>`

        this.qq.mount(host.querySelector("#qq-panel"))
        host.addEventListener('click', e => {
            const tab = e.target.closest('.music-tabs [data-tab]')
            if (tab) { this.switchTab(tab.dataset.tab); return }
            const btn = e.target.closest('button[data-action]')
            if (btn) this.handleAction(btn.dataset.action, btn)
        })
        host.addEventListener('input', e => this.handleInput(e))
        host.addEventListener('change', e => this.handleChange(e))
        host.addEventListener('dragstart', e => this.handleDragStart(e))
        host.addEventListener('dragover', e => this.handleDragOver(e))
        host.addEventListener('drop', e => this.handleDrop(e))
        host.addEventListener('dragend', () => this.clearDragMarks())

        // 面板内容刚重建，作废缓存签名，强制下一次 update 写入真实内容
        this._trackSignature = ''
        this._neteaseSignature = null
        this._miniIcon = null
        this._panelIcon = null

        this.switchTab(this.settings.music.tab || 'local')
    }

    switchTab (tab) {
        if (!['local', 'netease', 'qq'].includes(tab)) tab = 'local'
        this.settings.music.tab = tab
        this.persist()
        const host = this.panelHost
        if (!host) return
        host.querySelectorAll('.music-tabs [data-tab]').forEach(b => {
            const on = b.dataset.tab === tab
            b.setAttribute('aria-selected', String(on))
            b.classList.toggle('active', on)
        })
        host.querySelectorAll('.music-pane').forEach(p => { p.hidden = p.dataset.pane !== tab })
        this.update()
    }

    surface (st = this.player.getState()) {
        return musicSurface({
            localPlaying: st.playing,
            localCount: st.trackCount,
            qqMounted: this.qq.mounted,
            neteaseMounted: this.neteaseMounted,
        })
    }

    remoteHeight () {
        const { source } = this.surface()
        if (source === 'qq') return 100
        if (source === 'netease' && this.neteaseInfo) return neteaseEmbedHeight(this.neteaseInfo)
        return 100
    }

    remoteLabel () {
        const { source } = this.surface()
        if (source === 'qq') {
            const on = this.panelHost?.querySelector('#qq-lib-list .play.on .nm')
            return (on?.textContent || '').trim() || 'QQ 音乐'
        }
        if (source === 'netease' && this.neteaseInfo) {
            const kind = this.neteaseInfo.kind === 'song' ? '单曲' : this.neteaseInfo.kind === 'album' ? '专辑' : '歌单'
            return `网易云 · ${kind}`
        }
        return ''
    }

    // 官方播放器只存在一份，用固定定位贴到面板槽或底部迷你条，避免两套声音。
    syncLiveDock () {
        const live = this.live
        if (!live) return
        const st = this.player.getState()
        const surf = this.surface(st)
        const remote = surf.showRemote
        live.hidden = !remote
        if (!remote) {
            document.body.classList.remove('has-liveplayer')
            if (this._dockKey !== '') {
                this._dockKey = ''
                live.className = ''
                live.removeAttribute('style')
                this.onLayoutChange()
            }
            this.updateMini(st)
            return
        }
        live.style.setProperty('--live-h', this.remoteHeight() + 'px')
        const panelOpen = !document.getElementById('panel')?.classList.contains('hidden')
        const tab = this.settings.music.tab
        const slotSel = surf.source === 'qq' ? '#qq-player' : '#netease-box'
        const slot = panelOpen && tab === surf.source ? this.panelHost?.querySelector(slotSel) : null
        const rect = slot?.getBoundingClientRect()
        const inPanel = Boolean(rect && rect.width > 8 && rect.height > 8)
        if (inPanel) {
            const key = `panel|${Math.round(rect.left)}|${Math.round(rect.top)}|${Math.round(rect.width)}|${Math.round(rect.height)}`
            live.className = 'dock-panel'
            live.style.left = rect.left + 'px'
            live.style.top = rect.top + 'px'
            live.style.width = rect.width + 'px'
            live.style.height = rect.height + 'px'
            live.style.bottom = ''
            live.style.right = ''
            live.style.transform = ''
            if (this._dockKey !== key) { this._dockKey = key; this.onLayoutChange() }
        } else {
            const tall = this.remoteHeight() > 140
            live.className = tall ? 'dock-mini tall' : 'dock-mini'
            live.removeAttribute('style')
            live.style.setProperty('--live-h', this.remoteHeight() + 'px')
            const key = tall ? 'mini-tall' : 'mini'
            if (this._dockKey !== key) { this._dockKey = key; this.onLayoutChange() }
        }
        document.body.classList.toggle('has-liveplayer', live.classList.contains('dock-mini'))
        this.updateMini(st)
    }

    // ---------- 状态刷新 ----------

    // 与工具栏同步淡出：阅读时让出画面，鼠标/触摸/按键唤回。
    setFaded (faded) {
        if (this.mini) this.mini.classList.toggle('faded', Boolean(faded))
    }

    update () {
        const st = this.player.getState()
        this._lastState = st
        const surf = this.surface(st)

        // 工具栏的"乐"按钮显示播放状态
        const musicBtn = document.querySelector('#toolbar button[data-cmd="music"]')
        if (musicBtn) musicBtn.classList.toggle('is-playing', st.playing || surf.showRemote)

        this.updatePanel(st)
        this.syncLiveDock()
        const hasMini = surf.showLocalMini || (surf.showRemote && this.live?.classList.contains('dock-mini'))
        if (hasMini !== this._hasMini) {
            this._hasMini = hasMini
            document.body.classList.toggle('has-miniplayer', hasMini)
            this.onLayoutChange()
        }
    }

    updateMini (st) {
        const el = this.mini
        if (!el) return
        const surf = this.surface(st)
        const remote = surf.showRemote
        const panelOpen = !document.getElementById('panel')?.classList.contains('hidden')
        // QQ/网易云接管时唱机不再整块消失：转为「外部播放」展示态（盘面停转、唱臂归位、
        // 盘标显示远端曲目），官方播放器条压成暗色卡片在下方；窄屏由 CSS 让位。
        el.classList.toggle('hidden', st.trackCount === 0 && !remote)
        el.classList.toggle('tucked', panelOpen)
        el.classList.toggle('is-playing', Boolean(st.playing && !remote))
        el.classList.toggle('is-remote', remote)
        this.motion?.noteState(st)
        if (remote) {
            this.motion?.onRemote()
            const label = this.remoteLabel() || 'QQ 音乐'
            this.motion?.setLabel(label, 0, 'QQ')
            this.motion?.setHint(panelOpen ? '' : '官方播放器在下方')
            const title = document.getElementById('mp-title')
            if (title) {
                title.textContent = label
                title.classList.add('playing')
            }
            return
        }
        this.motion?.setHint('')
        if (st.trackCount === 0) return

        const title = document.getElementById('mp-title')
        if (title) {
            title.textContent = st.currentName || '选择一首开始播放'
            title.classList.toggle('playing', st.playing)
        }
        if (!this._puckDragging) {
            const on = el.classList.contains('puck-on')
            if (st.playing !== on) this.setPuck(st.playing ? DISC.x : REST.x, st.playing ? DISC.y : REST.y, true)
        }
        const puck = el.querySelector('#deck-puck')
        if (puck) puck.setAttribute('aria-pressed', String(!!st.playing))
    }

    updatePanel (st) {
        const host = this.panelHost
        if (!host || !host.querySelector('.music-tabs')) return
        const $id = id => host.querySelector('#' + id)

        // 正在播放卡片：与画面是同一路，官方播放器激活时不再显示本地曲名
        const surf = this.surface(st)
        const title = $id('np-title')
        if (title) {
            title.textContent = surf.showRemote
                ? this.remoteLabel()
                : (st.currentName || '未在播放')
            title.classList.toggle('playing', st.playing || surf.showRemote)
        }
        const sub = $id('np-sub')
        if (sub) {
            sub.textContent = surf.showRemote
                ? '与画面是同一个播放器。点上方分页即可看到官方控件。'
                : (st.currentName
                    ? `${st.playing ? '正在播放' : '已暂停'} · 第 ${st.index + 1} / ${st.trackCount} 首`
                    : (st.trackCount ? `${st.trackCount} 首本地音乐，点击曲目开始播放` : '导入音乐后即可开始'))
        }
        const art = host.querySelector('.np-art')
        if (art) art.classList.toggle('playing', st.playing)

        const toggle = $id('btn-toggle')
        if (toggle) {
            const want = st.playing ? 'pause' : 'play'
            if (this._panelIcon !== want) {
                this._panelIcon = want
                toggle.innerHTML = icon(want)
            }
            toggle.setAttribute('aria-label', st.playing ? '暂停' : '播放')
        }
        const seek = $id('np-seek')
        const time = $id('np-time')
        const dur = $id('np-dur')
        if (seek && !this._seekDragging) {
            const d = st.duration || 0
            seek.max = String(d > 0 ? d : 1)
            seek.disabled = !(d > 0)
            seek.value = String(clamp(st.time, 0, d > 0 ? d : 1))
            seek.style.setProperty('--p', d > 0 ? `${(st.time / d) * 100}%` : '0%')
        }
        if (time && !this._seekDragging) time.textContent = formatTime(st.time)
        if (dur) dur.textContent = formatTime(st.duration)

        // 随机 / 循环
        const shuffleBtn = $id('btn-shuffle')
        if (shuffleBtn) {
            shuffleBtn.setAttribute('aria-pressed', String(st.shuffle))
            shuffleBtn.classList.toggle('on', st.shuffle)
            shuffleBtn.title = st.shuffle ? '随机播放（已开启）' : '随机播放'
        }
        const loopBtn = $id('btn-loop')
        if (loopBtn) {
            const mode = LOOP_MODES.find(m => m.value === st.loop) || LOOP_MODES[0]
            if (loopBtn.dataset.mode !== st.loop) {
                loopBtn.dataset.mode = st.loop
                loopBtn.innerHTML = icon(mode.icon)
            }
            loopBtn.title = `循环方式：${mode.label}`
            loopBtn.classList.toggle('on', st.loop !== 'none')
        }

        // 音量
        const vol = $id('vol-range')
        if (vol && document.activeElement !== vol) {
            vol.value = String(st.volume)
            vol.style.setProperty('--p', `${st.volume * 100}%`)
        }
        const volLabel = $id('v-vol')
        if (volLabel) volLabel.textContent = `${Math.round(st.volume * 100)}%`
        const muteBtn = $id('btn-mute')
        if (muteBtn) {
            muteBtn.innerHTML = icon(st.muted || st.volume === 0 ? 'volumeMute' : 'volume')
            muteBtn.setAttribute('aria-pressed', String(st.muted))
            muteBtn.classList.toggle('on', st.muted)
            muteBtn.title = st.muted ? '取消静音' : '静音'
        }
        const fade = $id('chk-fade')
        if (fade) fade.checked = st.fade

        // 睡眠定时
        const sleepSel = $id('sel-sleep')
        if (sleepSel && document.activeElement !== sleepSel) {
            sleepSel.value = st.sleepAfterTrack ? 'track' : (st.sleepUntil ? sleepSel.dataset.pending || 'off' : 'off')
        }
        const sleepStatus = $id('sleep-status')
        if (sleepStatus) {
            if (st.sleepUntil) sleepStatus.textContent = `剩余 ${formatTime(Math.max(0, (st.sleepUntil - Date.now()) / 1000))}`
            else if (st.sleepAfterTrack) sleepStatus.textContent = '播完本曲暂停'
            else sleepStatus.textContent = ''
        }
        this.tickSleep(st)

        // 曲目列表
        this.updateTrackList(st)
        this.updateNetease(st)
    }

    tickSleep (st) {
        const active = Boolean(st.sleepUntil)
        if (active && !this._sleepTicker) {
            this._sleepTicker = setInterval(() => {
                const s = this.player.getState()
                const el = this.panelHost?.querySelector('#sleep-status')
                if (el && s.sleepUntil) el.textContent = `剩余 ${formatTime(Math.max(0, (s.sleepUntil - Date.now()) / 1000))}`
                if (!s.sleepUntil) { clearInterval(this._sleepTicker); this._sleepTicker = null }
            }, 1000)
        } else if (!active && this._sleepTicker) {
            clearInterval(this._sleepTicker)
            this._sleepTicker = null
        }
    }

    updateTrackList (st) {
        const list = this.panelHost?.querySelector('#track-list')
        if (!list) return
        const count = this.panelHost.querySelector('#track-count')
        if (count) count.textContent = st.trackCount ? `（${st.trackCount}）` : ''

        const signature = JSON.stringify([
            this.player.tracks.map(t => [t.id, t.name, Math.round(this.player.durationOf(t.id))]),
            st.currentId, st.playing, this.editingId,
        ])
        if (signature === this._trackSignature) return
        this._trackSignature = signature

        if (!st.trackCount) {
            list.innerHTML = '<li class="track-empty">还没有音乐。导入自己的轻音乐，或在上方使用网易云。</li>'
            return
        }
        list.innerHTML = this.player.tracks.map((t, i) => {
            const active = t.id === st.currentId
            if (t.id === this.editingId) {
                return `<li class="track-item editing" data-id="${escapeHtml(t.id)}">
                    <input class="rename-input" type="text" maxlength="120" value="${escapeHtml(t.name)}" aria-label="曲目名称">
                    <button data-action="save-rename" data-id="${escapeHtml(t.id)}" class="primary">保存</button>
                    <button data-action="cancel-rename">取消</button>
                </li>`
            }
            const d = this.player.durationOf(t.id)
            return `<li class="track-item ${active ? 'playing' : ''}" data-id="${escapeHtml(t.id)}" draggable="true">
                <span class="grip" title="拖动排序" aria-hidden="true">${icon('grip')}</span>
                <span class="idx">${i + 1}</span>
                <button class="tn" data-action="play-track" data-id="${escapeHtml(t.id)}"
                        title="${escapeHtml(t.name)}" aria-label="${active && st.playing ? '暂停' : '播放'} ${escapeHtml(t.name)}">
                    ${active ? `<span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>` : ''}
                    <span class="nm">${escapeHtml(t.name)}</span>
                </button>
                <span class="td">${d ? formatTime(d) : '–:–'}</span>
                <button data-action="rename-track" data-id="${escapeHtml(t.id)}" aria-label="重命名 ${escapeHtml(t.name)}" title="重命名">${icon('edit')}</button>
                <button data-action="delete-track" data-id="${escapeHtml(t.id)}" aria-label="删除 ${escapeHtml(t.name)}" title="删除">${icon('trash')}</button>
            </li>`
        }).join('')

        // 补齐尚未探测过的时长
        for (const t of this.player.tracks) {
            if (!this.player.durationOf(t.id)) this.player.probeDuration(t.id)
        }
    }

    // ---------- 网易云 ----------

    setNetease (info) {
        this.neteaseInfo = info || null
        this.neteaseMounted = Boolean(info)
        this.updateNetease(this.player.getState())
    }

    embedNetease (result) {
        this.qq.unmount()
        this.player.stop()
        this.neteaseInfo = result
        this.neteaseMounted = true
        this.settings.music.netease = { kind: result.kind, type: result.type, id: result.id }
        this.persist()
        this.mountNeteaseFrame()
        this.updateNetease(this.player.getState())
        this.syncLiveDock()
    }

    unmountNetease (clear = false) {
        this.neteaseMounted = false
        if (clear) {
            this.neteaseInfo = null
            this.settings.music.netease = null
            this.persist()
        }
        const live = this.live
        if (live?.querySelector('iframe[data-source="netease"]')) live.replaceChildren()
        this.updateNetease(this.player.getState())
        this.syncLiveDock()
    }

    mountNeteaseFrame () {
        const live = this.live
        const info = this.neteaseInfo
        if (!live || !info) return
        const src = buildPlayerUrl(info)
        let iframe = live.querySelector('iframe')
        if (!iframe || iframe.getAttribute('src') !== src) {
            iframe = document.createElement('iframe')
            iframe.title = '网易云音乐外链播放器'
            iframe.allow = 'autoplay'
            iframe.referrerPolicy = 'strict-origin-when-cross-origin'
            iframe.dataset.source = 'netease'
            iframe.addEventListener('load', () => {
                iframe.dataset.loaded = 'true'
                this.updateNetease()
            })
            iframe.src = src
            live.replaceChildren(iframe)
        }
        live.hidden = false
    }

    updateNetease () {
        const host = this.panelHost
        if (!host) return
        const box = host.querySelector('#netease-box')
        const actions = host.querySelector('#netease-actions')
        const status = host.querySelector('#netease-status')
        if (!box) return

        const localPlaying = this.player.getState().playing
        const info = this.neteaseInfo
        const mounted = this.neteaseMounted && Boolean(info)
        if (mounted) {
            box.style.minHeight = neteaseEmbedHeight(info) + 'px'
            box.classList.add('on')
            this.mountNeteaseFrame()
        } else {
            box.style.minHeight = ''
            box.classList.remove('on')
        }

        const loaded = this.live?.querySelector('iframe[data-source="netease"]')?.dataset.loaded === 'true'
        if (mounted) {
            const signature = `mounted|${info.type}|${info.id}|${loaded ? 1 : 0}`
            if (this._neteaseSignature !== signature) {
                this._neteaseSignature = signature
                actions.innerHTML = `<a href="${buildOpenUrl(info)}" target="_blank" rel="noopener noreferrer">在网易云打开 ↗</a>
                    <button data-action="netease-remove">移除播放器</button>`
                status.textContent = loaded
                    ? '画面里的播放器与这里是同一路。请在官方控件里点播放。'
                    : '正在请求官方播放器。若长时间空白，可在网易云打开或使用本地音乐。'
            }
        } else {
            const signature = `unmounted|${info ? info.type + ':' + info.id : 'none'}|${localPlaying ? 1 : 0}`
            if (this._neteaseSignature !== signature) {
                this._neteaseSignature = signature
                actions.innerHTML = info
                    ? `<button data-action="netease-show">打开网易云播放器</button>
                       <a href="${buildOpenUrl(info)}" target="_blank" rel="noopener noreferrer">在网易云打开 ↗</a>`
                    : ''
                status.textContent = info && localPlaying ? '已切换到本地音乐，与画面迷你条是同一路。' : ''
            }
        }
    }

    // ---------- 交互 ----------

    handleAction (action, btn) {
        const p = this.player
        const id = btn?.dataset?.id
        switch (action) {
            case 'open-panel': this.onAction('open-panel'); break
            case 'toggle': {
                const surf = this.surface()
                if (surf.source !== 'local') { this.switchTab(surf.source); this.onAction('open-panel'); break }
                p.toggle()
                break
            }
            case 'prev': p.prev(); break
            case 'next': p.next(); break
            case 'play-track':
                if (p.currentId === id) p.toggle()
                else p.play(id)
                break
            case 'shuffle':
                p.setShuffle(!p.getState().shuffle)
                this.settings.music.shuffle = p.getState().shuffle
                this.persist()
                break
            case 'loop': {
                const order = ['all', 'one', 'none']
                const next = order[(order.indexOf(p.getState().loop) + 1) % order.length]
                p.setLoop(next)
                this.settings.music.loop = next
                this.persist()
                this.onToast(`循环方式：${LOOP_MODES.find(m => m.value === next).label}`)
                break
            }
            case 'mute':
                p.setMuted(!p.getState().muted)
                this.settings.music.muted = p.getState().muted
                this.persist()
                break
            case 'pick-audio': this.onAction('pick-audio'); break
            case 'rename-track':
                this.editingId = id
                this._trackSignature = ''
                this.update()
                this.panelHost.querySelector('.rename-input')?.select()
                break
            case 'cancel-rename':
                this.editingId = null
                this._trackSignature = ''
                this.update()
                break
            case 'save-rename': {
                const input = this.panelHost.querySelector('.rename-input')
                const name = (input?.value || '').trim()
                if (!name) { this.onToast('请输入曲目名称'); break }
                this.editingId = null
                this._trackSignature = ''
                this.onAction('rename-track', { id, name })
                break
            }
            case 'delete-track': this.onAction('delete-track', { id }); break
            case 'netease-embed': {
                const input = this.panelHost.querySelector('#netease-input')
                this.onAction('netease-embed', { value: input?.value || '' })
                break
            }
            case 'netease-remove': this.unmountNetease(true); break
            case 'netease-show': this.embedNetease(this.neteaseInfo); break
        }
    }

    handleInput (e) {
        const t = e.target
        if (t.id === 'np-seek' || t.id === 'mp-seek') {
            this._seekDragging = true
            const st = this.player.getState()
            const label = t.id === 'np-seek'
                ? this.panelHost?.querySelector('#np-time')
                : document.getElementById('mp-time')
            if (label) label.textContent = formatTime(Number(t.value))
            t.style.setProperty('--p', st.duration > 0 ? `${(Number(t.value) / st.duration) * 100}%` : '0%')
            return
        }
        if (t.dataset.setting === 'volume') {
            const v = Number(t.value)
            this.player.setVolume(v)
            this.settings.music.volume = v
            this.settings.music.muted = false
            this.persist()
            const label = this.panelHost?.querySelector('#v-vol')
            if (label) label.textContent = `${Math.round(v * 100)}%`
            t.style.setProperty('--p', `${v * 100}%`)
        }
    }

    handleChange (e) {
        const t = e.target
        if (t.id === 'np-seek' || t.id === 'mp-seek') {
            this._seekDragging = false
            this.player.seek(Number(t.value))
            return
        }
        if (t.id === 'chk-fade') {
            this.settings.music.fade = t.checked
            this.persist()
            this.player.setFadeEnabled(t.checked)
        } else if (t.id === 'sel-sleep') {
            if (t.value === 'off') this.player.setSleep(null)
            else if (t.value === 'track') this.player.setSleep({ type: 'track' })
            else {
                t.dataset.pending = t.value
                this.player.setSleep({ type: 'minutes', minutes: Number(t.value) })
                this.onToast(`睡眠定时：${t.value} 分钟后暂停`)
            }
            if (t.value === 'off') delete t.dataset.pending
        }
    }

    // ---------- 拖拽排序 ----------

    handleDragStart (e) {
        const li = e.target.closest('.track-item')
        if (!li || this.editingId) return
        this._dragId = li.dataset.id
        li.classList.add('dragging')
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', this._dragId) } catch { /* 兼容性 */ }
    }

    handleDragOver (e) {
        const li = e.target.closest('.track-item')
        if (!li || !this._dragId || li.dataset.id === this._dragId) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        this.clearDragMarks()
        li.classList.add('drop-target')
    }

    handleDrop (e) {
        const li = e.target.closest('.track-item')
        if (!li || !this._dragId) return
        e.preventDefault()
        const ids = this.player.tracks.map(t => t.id)
        const from = ids.indexOf(this._dragId)
        const to = ids.indexOf(li.dataset.id)
        this.clearDragMarks()
        this._dragId = null
        if (from < 0 || to < 0 || from === to) return
        ids.splice(to, 0, ids.splice(from, 1)[0])
        this.onAction('reorder', { ids })
    }

    clearDragMarks () {
        this.panelHost?.querySelectorAll('.track-item').forEach(li =>
            li.classList.remove('dragging', 'drop-target'))
    }
}

export { LOOP_MODES, SLEEP_OPTIONS }
