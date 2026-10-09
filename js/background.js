// 场景控制器：意境背景（内置示意 SVG + 用户上传）、固定/按时段/按分钟轮换、
// 双层交叉渐变，并在每次换图时驱动可读性引擎，保证渐变全程正文对比度不跌出 4.5:1。

import { computeReadability, sampleRegion, relativeLuminance } from './readability.js'
import { RainGlass } from './rain-glass.js'
import { isVideo, loadBackgroundVideo, releaseVideo } from './background-media.js'
import { isThreeScene, threeSceneName, ThreeSceneRenderer } from './three-scene.js'
import { saveSettings } from './settings.js'

// 动态源亮度巡检用：按步长抽样 + 256 档查找表求均值。
// 旧写法每像素 slice() 一个临时数组再调 relativeLuminance（正文列 120×600 ≈ 72,000 次分配 + 21.6 万次
// Math.pow，每 2s 一轮）。查找表与 relativeLuminance 同一口径：灰阶入参时三系数和为 1，
// 所以 relativeLuminance([c,c,c]) 就是该通道的线性值，将来 readability.js 换公式这里自动跟着走。
const CHANNEL_L = (() => {
    const lut = new Float32Array(256)
    for (let c = 0; c < 256; c++) lut[c] = relativeLuminance([c, c, c])
    return lut
})()
const MAX_PROBES = 1024

export function meanLuminance (pixels, n) {
    const step = Math.max(1, Math.floor(n / MAX_PROBES))
    let sum = 0, probes = 0
    for (let i = 0; i < n; i += step) {
        const o = i * 4
        sum += 0.2126 * CHANNEL_L[pixels[o]] + 0.7152 * CHANNEL_L[pixels[o + 1]] + 0.0722 * CHANNEL_L[pixels[o + 2]]
        probes++
    }
    return probes ? sum / probes : 0
}

// 深浅字方案切换的滞回参数（见 acceptThemeSwitch）
const THEME_HYSTERESIS = 0.03
const THEME_CONFIRMATIONS = 2
const MASK_EASE_MS = 600

export const BUILTIN_BACKGROUNDS = [
    { id: 'three:mountains-dawn', name: '群山黎明 · 动态', three: true },
    { id: 'three:aurora-night', name: '极光夜空 · 动态', three: true },
    { id: 'builtin:fluid', name: '双色流体', file: 'fluid.svg' },
    { id: 'builtin:garden-dawn', name: '花园晨光', file: 'garden-dawn.svg' },
    { id: 'builtin:grassland-day', name: '草原白昼', file: 'grassland-day.svg' },
    { id: 'builtin:forest-dusk', name: '森林暮色', file: 'forest-dusk.svg' },
    { id: 'builtin:lake-night', name: '湖畔星夜', file: 'lake-night.svg' },
    { id: 'builtin:rain-garden', name: '雨中庭园', file: 'rain-garden.svg' },
    { id: 'builtin:snow-field', name: '雪原黄昏', file: 'snow-field.svg' },
    { id: 'builtin:fp-desk', name: '书房书桌 · 立体书', file: 'fp-desk.svg', firstPerson: true },
    { id: 'builtin:fp-valley', name: '山谷晨光 · 写实立体书', file: 'fp-valley-real.png', firstPerson: true },
    { id: 'builtin:fp-cafe', name: '咖啡厅桌 · 立体书', file: 'fp-cafe.svg', firstPerson: true },
    { id: 'builtin:fp-cliff', name: '山崖座椅 · 立体书', file: 'fp-cliff.svg', firstPerson: true },
]

export function isFirstPersonRef (refId) {
    return String(refId || '').startsWith('builtin:fp-')
}

export const SLOT_ORDER = ['morning', 'day', 'evening', 'night']
export const SLOT_LABELS = { morning: '早晨 5–10 点', day: '白天 10–17 点', evening: '傍晚 17–20 点', night: '夜间 20–5 点' }

export function slotByHour (hour) {
    if (hour >= 5 && hour < 10) return 'morning'
    if (hour >= 10 && hour < 17) return 'day'
    if (hour >= 17 && hour < 20) return 'evening'
    return 'night'
}

const FADE_MS = 1400


export class SceneController extends EventTarget {
    constructor ({ settings, getRect, onToast }) {
        super()
        this.settings = settings
        this.getRect = getRect // () => 正文列 DOMRect（视口坐标）
        this.onToast = onToast // 轮换/切换失败时的一次性用户提示（可为空）
        this.userBgs = [] // IndexedDB 中的背景列表
        this._version = 0
        this.abort = new AbortController()
        this._fadeAnimations = []
        this.currentRef = null
        this.currentImage = null
        this.currentPlan = null // 当前生效的 readability plan
        this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
        this.fadeEnabled = !this.reducedMotion.matches &&
            settings.background.animate !== false
        this.rotationIndex = 0
        this.lastSwitchAt = 0
        this._themeFlip = 0 // 深浅字方案切换的连续确认计数（滞回）
        this.urlCache = new Map() // refId → objectURL / asset URL
        this.imageCache = new Map() // url → HTMLImageElement（LRU 上限）

        this.root = document.getElementById('bg-root')
        this.maskEl = document.getElementById('readability-mask')
        this.layers = [document.createElement('div'), document.createElement('div')]
        this.activeLayer = 0
        for (const el of this.layers) {
            el.className = 'bg-layer'
            this.root.append(el)
        }
        this.layers[0].style.opacity = '0'
        this.rain = new RainGlass(this.root, settings.atmosphere)
    }

    // ---------- 解析与缓存 ----------
    sceneMotionEnabled () {
        return this.settings.atmosphere.motion !== false && !this.reducedMotion.matches
    }

    isBuiltin (refId) { return String(refId).startsWith('builtin:') || isThreeScene(refId) }

    builtinOf (refId) { return BUILTIN_BACKGROUNDS.find(b => b.id === refId) }

    urlOf (refId) {
        if (isThreeScene(refId)) return '' // three 场景直接渲染到离屏 canvas，无 URL
        if (this.urlCache.has(refId)) return this.urlCache.get(refId)
        let url
        if (this.isBuiltin(refId)) {
            const b = this.builtinOf(refId)
            url = b ? `assets/backgrounds/${b.file}` : null
        } else {
            const rec = this.userBgs.find(b => b.id === refId)
            url = rec ? URL.createObjectURL(rec.data) : null
        }
        if (url) this.urlCache.set(refId, url)
        return url
    }

    dropUrl (refId) {
        const url = this.urlCache.get(refId)
        for (const cached of this.imageCache.values()) if (cached.refId === refId && cached.img.tagName === 'VIDEO') releaseVideo(cached.img)
        if (url && !this.isBuiltin(refId)) URL.revokeObjectURL(url)
        this.urlCache.delete(refId)
        for (const [k, v] of this.imageCache) {
            if (v.refId === refId) this.imageCache.delete(k)
        }
    }

    loadImage (refId) {
        if (isThreeScene(refId)) {
            if (!this.threeRenderer) this.threeRenderer = new ThreeSceneRenderer()
            // 前一 three 场景停止渲染，只保留当前一个活动渲染循环
            // 2D 渲染不依赖 WebGL：即使显卡/硬件加速不可用也能出画面（旧版在此静默失败）
            const canvas = this.threeRenderer.start(refId, { motion: this.sceneMotionEnabled() })
            if (!canvas) return Promise.reject(new Error('动态场景初始化失败'))
            return Promise.resolve(canvas)
        }
        const url = this.urlOf(refId)
        if (!url) return Promise.reject(new Error(`找不到背景：${refId}`))
        const hit = this.imageCache.get(url)
        if (hit) return Promise.resolve(hit.img)
        if (isVideo(this.userBgs.find(b => b.id === refId)?.data)) {
            return loadBackgroundVideo(url).then(video => {
                this.imageCache.set(url, {img: video, refId})
                return video
            })
        }
        return new Promise((resolve, reject) => {
            const img = new Image()
            img.onload = () => {
                this.imageCache.set(url, { img, refId })
                if (this.imageCache.size > 8) {
                    const oldest = this.imageCache.keys().next().value
                    if (this.imageCache.size > 8) this.imageCache.delete(oldest)
                }
                resolve(img)
            }
            img.onerror = () => reject(new Error('背景图片解码失败'))
            img.src = url
        })
    }

    // ---------- 背景池与选择 ----------
    allRefs () {
        return [...BUILTIN_BACKGROUNDS.map(b => b.id),
            ...this.userBgs.map(b => b.id)]
    }

    refName (refId) {
        if (isThreeScene(refId)) return threeSceneName(refId)
        const b = this.builtinOf(refId)
        if (b) return b.name
        const u = this.userBgs.find(x => x.id === refId)
        return u ? u.name : '（已删除）'
    }

    // 动态场景缩略图（渲染单帧，结果缓存）；供场景面板展示真实预览而非文字占位
    scenePreview (refId) {
        if (!isThreeScene(refId)) return ''
        if (!this.threeRenderer) this.threeRenderer = new ThreeSceneRenderer()
        return this.threeRenderer.snapshot(refId, 240, 135)
    }

    pickDesired () {
        const bg = this.settings.background
        if (bg.mode === 'fixed') return bg.fixedId
        if (bg.mode === 'slot') return bg.slotMap[slotByHour(new Date().getHours())]
        // rotate：在全部可用背景间轮换
        const pool = this.allRefs()
        if (!pool.length) return null
        this.rotationIndex = ((this.rotationIndex % pool.length) + pool.length) % pool.length
        return pool[this.rotationIndex]
    }

    // ---------- 生命周期 ----------
    async setUserBackgrounds(list) {
        for (const old of this.userBgs) {
            const next = list.find(b => b.id === old.id)
            if (!next) this.dropUrl(old.id)
        }
        this.userBgs = list
        const valid = new Set(this.allRefs()), fallback = 'builtin:fluid'
        const bg = this.settings.background
        let changed = false
        if (!valid.has(bg.fixedId)) { bg.fixedId = fallback; changed = true }
        for (const slot of SLOT_ORDER) {
            if (!valid.has(bg.slotMap[slot])) { bg.slotMap[slot] = fallback; changed = true }
        }
        if (changed) saveSettings(this.settings)
        if (this.currentRef && !valid.has(this.currentRef)) {
            await this.applyDesired({ force: true, animate: false })
        }
    }

    async init () {
        // 启动兜底：一张损坏的自选背景（id 存在但 blob/资产解码失败）不能把整个
        // 应用初始化拖死——init 之后的开书恢复、遮罩几何、音乐恢复全都排在后面。
        // 兜底图不写回 settings.background.fixedId：用户的选择保留，下次启动先重试
        // 原背景，仍是这张坏图就再兜底一次。
        try {
            await this.applyDesired({ force: true, animate: false })
        } catch (error) {
            console.error('启动背景加载失败，改用内置兜底背景：', error)
            try {
                await this.setRef('builtin:fluid', { animate: false })
                this.onToast?.('上次选择的背景已损坏，已临时改用内置背景；可在「阅读环境」里重新选择')
            } catch (fallbackError) {
                // 兜底图也失败：图层留空（纯色底）继续启动，绝不向上抛
                console.error('兜底背景也加载失败：', fallbackError)
            }
        }
        this.reducedMotion.addEventListener('change', () => this.onSettingsChanged(), { signal: this.abort.signal })
        this.lastSwitchAt = Date.now()
        this.timer = setInterval(() => this.tick(), 30000)
        // 动态源亮度巡检只有一路：startDynamicWatch（由 setRef 末尾启动）。
        // 旧版这里还起了 startDynamicTracking()——同一段 sampleRegion 逻辑、另一套基线，
        // 两路各自独立触发 recomputeReadability，已删除。
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.tick()
        }, {signal: this.abort.signal})
        window.addEventListener('resize', () => {
            clearTimeout(this._resizeT)
            this._resizeT = setTimeout(() => this.recomputeReadability(), 200)
        }, {signal: this.abort.signal})
    }

    destroy () {
        this._version++
        this.abort.abort()
        clearInterval(this.timer); clearTimeout(this._resizeT)
        clearInterval(this._dynamicTimer); this._dynamicTimer = null
        this.threeRenderer?.stop()
        this._fadeAnimations.forEach(a => a.cancel())
        this.rain.destroy()
        for (const ref of [...this.urlCache.keys()]) this.dropUrl(ref)
        this.imageCache.clear()
        this.layers.forEach(layer => layer.remove())
    }

    // 轮换/切换失败的一次性提示：坏图会让 fixed 模式每 30s 重试一次，
    // 不加 flag 会刷屏；flag 只在 setRef 成功时复位，恢复后才会再次报错。
    _notifyFailure (error) {
        console.error('背景切换失败：', error)
        if (this._failToasted) return
        this._failToasted = true
        this.onToast?.('背景切换失败（素材可能已损坏），已保留当前背景；可在「阅读环境」里换一张')
    }

    tick () {
        if (document.visibilityState !== 'visible') return
        const bg = this.settings.background
        if (bg.mode === 'rotate') {
            const interval = Math.max(1, Number(bg.rotateMinutes) || 15) * 60000
            if (Date.now() - this.lastSwitchAt >= interval) {
                this.rotationIndex++
                this.lastSwitchAt = Date.now()
                this.applyDesired().catch(e => this._notifyFailure(e))
                return
            }
        }
        // fixed/slot：期望图变化时（时段切换）才换
        const desired = this.pickDesired()
        if (desired && desired !== this.currentRef) {
            this.applyDesired().catch(e => this._notifyFailure(e))
        }
    }

    onSettingsChanged () {
        this.fadeEnabled = !this.reducedMotion.matches &&
            this.settings.background.animate !== false
        // 阅读环境快选也会修改 atmosphere；重新唤醒已暂停的雨窗渲染。
        this.rain.update(this.settings.atmosphere)
        this.threeRenderer?.setMotionEnabled(this.sceneMotionEnabled())
        // 轮换池起点保持连续；固定/时段立即生效
        const desired = this.pickDesired()
        if (desired && desired !== this.currentRef) {
            this.applyDesired().catch(e => this._notifyFailure(e))
        }
    }

    // ---------- 应用一张背景 + 可读性 ----------
    async applyDesired ({ force = false, animate } = {}) {
        const ref = this.pickDesired()
        if (!ref) return
        if (ref === this.currentRef && !force) return
        await this.setRef(ref, { animate })
    }

    async setRef(refId, { animate } = {}) {
        const version = ++this._version
        const img = await this.loadImage(refId)
        if (version !== this._version) { if (img.tagName === 'VIDEO') img.pause(); return }
        const plan = this.planFor(img)
        if (!isThreeScene(refId)) this.threeRenderer?.stop() // 离开 three 场景后停掉 rAF，避免空耗 GPU
        const previous = this.currentPlan
        this._fadeAnimations.forEach(a => a.cancel())
        this._fadeAnimations = []
        const oldLayer = this.layers[this.activeLayer]
        const newLayer = this.layers[1 - this.activeLayer]
        // Keep the previous image opaque; only fade the new image over it.
        oldLayer.style.opacity = '1'
        oldLayer.style.zIndex = '0'
        newLayer.style.zIndex = '1'
        newLayer.replaceChildren()
        const video = img.tagName === 'VIDEO'
        const three = isThreeScene(refId)
        newLayer.style.backgroundColor = 'transparent'
        newLayer.style.backgroundImage = (video || three) ? 'none' : `url("${this.urlOf(refId)}")`
        if (video) newLayer.append(img)
        // 保留原始画布作为常驻底图，雨窗丢失上下文或渲染失败时仍可显示场景。
        if (three) {
            newLayer.style.backgroundColor = '#0a0f14'
            img.className = 'scene-canvas'
            newLayer.append(img)
        }
        // 先落当前引用再触发 rain.setSource：status 事件会同步驱动面板刷新，
        // 顺序颠倒会让状态栏在整个淡入期间显示上一个背景的名字。
        this.currentRef = refId
        this.currentImage = img
        this.currentPlan = plan
        this._lastDynLum = null // 新 plan 生成：动态源亮度基准待重建
        this._themeFlip = 0 // 换背景是真变化，不套用上一背景的滞回计数
        // 所有背景都传入真实素材：图片也需要上传为雨窗纹理，不能用空纹理遮住底图。
        this.rain.setSource({kind: three ? 'three' : refId === 'builtin:fluid' ? 'fluid' : video ? 'video' : 'image', element: img}, (animate ?? this.fadeEnabled) && !!previous)
        newLayer.style.opacity = '1'
        // Atomic ink + mask update, with a proven all-pixel alpha bound during the entire fade.
        this.applyPlan(plan)
        const doFade = (animate ?? this.fadeEnabled) && previous
        if (doFade) {
            const animation = newLayer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: 'ease' })
            this._fadeAnimations = [animation]
            // 后台/节流标签页动画时间不推进，finished 可能永不兑现 → 只等一个淡入时长，
            // 超时也继续完成切换（scenechange/面板高亮不能被动画卡死）
            await Promise.race([animation.finished.catch(() => {}), new Promise(resolve => setTimeout(resolve, FADE_MS + 400))])
        }
        if (version !== this._version) return
        oldLayer.style.opacity = '0'
        oldLayer.style.backgroundImage = ''
        for (const child of [...oldLayer.children]) if (child !== img) child.remove()
        // Only the selected video remains decoded; loading a library must not leave many videos alive.
        for (const [key, cached] of this.imageCache) {
            if (cached.img.tagName === 'VIDEO' && cached.img !== img) { releaseVideo(cached.img);this.imageCache.delete(key) }
        }
        this.activeLayer = 1 - this.activeLayer
        this._fadeAnimations = []
        this._failToasted = false // 这次切换成功了：下次再失败允许重新提示
        this.dispatchEvent(new CustomEvent('scenechange', {
            detail: { refId, name: this.refName(refId), readability: plan },
        }))
        this.startDynamicWatch()
    }

    planFor(image) {
        return computeReadability({ image, rect: this.readRect(), vw: innerWidth, vh: innerHeight,
            forcedTheme: this.settings.readability.theme === 'auto' ? null : this.settings.readability.theme,
            maskBias: this.settings.readability.maskBias })
    }

    readRect () {
        const r = this.getRect()
        const x = Math.max(0, r.left)
        const y = Math.max(0, r.top)
        const width = Math.min(window.innerWidth, r.right) - x
        const height = Math.min(window.innerHeight, r.bottom) - y
        return { x, y, width: Math.max(1, width), height: Math.max(1, height) }
    }

    // instant=true：换背景时的原子落位。此时背景图层自身正在做交叉渐变，遮罩必须一步到位，
    // 两个动画叠在一起会在淡入中段出现可见的墨色跳动，所以这里关掉过渡。
    // instant=false：resize / 排版变化 / 动态源漂移的重新计算 → 兑现方法注释里的「平滑过渡到新的遮罩强度」。
    // css/style.css:24 的 #readability-mask 没有定义 transition，平滑只能由这里给（CSS 由另一代理负责）。
    applyPlan(plan, { instant = true } = {}) {
        this.maskEl.style.transition = instant ? 'none'
            : `opacity ${MASK_EASE_MS}ms ease, background-color ${MASK_EASE_MS}ms ease`
        this.maskEl.style.backgroundColor = plan.maskColor
        this.maskEl.style.opacity = String(plan.maskAlpha)
        this.dispatchEvent(new CustomEvent('texttheme', {
            detail: { theme: plan.theme, textColor: plan.textColor },
        }))
    }

    // 深浅字方案滞回（hysteresis）+ 遮罩平滑过渡，两者都做了：
    // 只恢复过渡止不住硬闪——正文墨色走 texttheme → applyInk，是瞬间换色的；
    // 只有不让方案在 alphaForDark/alphaForLight 交叉点上来回切，闪才不会发生。
    // 因此：换方案需要「新方案确实更省 ≥ THEME_HYSTERESIS」且「连续 THEME_CONFIRMATIONS 轮成立」；
    // 落选时继续沿用当前方案的颜色，但采用本轮新采样出的该方案遮罩强度（配合过渡平滑跟随漂移）。
    acceptThemeSwitch (plan) {
        const current = this.currentPlan
        if (!current || plan.theme === current.theme) { this._themeFlip = 0; return plan }
        if (this.settings.readability.theme !== 'auto') { this._themeFlip = 0; return plan } // 用户强制，直接照办
        const ours = plan.plan[plan.theme].maskAlpha
        const heldAlpha = plan.plan[current.theme].maskAlpha
        const held = () => ({
            ...plan,
            theme: current.theme,
            maskColor: current.maskColor,
            textColor: current.textColor,
            maskAlpha: heldAlpha,
            otherAlpha: ours,
        })
        if (ours + THEME_HYSTERESIS > heldAlpha) { this._themeFlip = 0; return held() } // 成本打平或现方案更优
        this._themeFlip = (this._themeFlip || 0) + 1
        if (this._themeFlip < THEME_CONFIRMATIONS) return held() // 还没连续确认
        this._themeFlip = 0
        return plan
    }

    // 动态源（视频 / three 画布）的画面随时间变化，静态 plan 会过时。
    // 这是全仓唯一的一路「正文列亮度周期巡检」：每 2s 抽测均值，漂移 >0.04 才重算可读性，
    // 页面隐藏时跳过。雨滴高光用的场景均值亮度由 main.js:2102 的 sceneLumTimer 负责（另一代理的文件，
    // 不在本文件范围内）；旧版在本文件里还有第二条同逻辑、另一套基线的 startDynamicTracking()，已删除。
    startDynamicWatch () {
        this._lastDynLum = null // 新背景：亮度基准重建（定时器已在跑时同样要重置）
        if (this._dynamicTimer) return
        this._dynamicTimer = setInterval(() => {
            if (document.hidden || !this.currentImage || !this.currentPlan) return
            const tag = this.currentImage.tagName
            if (tag !== 'VIDEO' && tag !== 'CANVAS') return
            try {
                const sample = sampleRegion(this.currentImage, this.readRect(), innerWidth, innerHeight)
                if (!sample || !sample.n) return
                const lum = meanLuminance(sample.pixels, sample.n)
                if (this._lastDynLum !== null && Math.abs(lum - this._lastDynLum) > 0.04) this.recomputeReadability()
                this._lastDynLum = lum
            } catch { /* 采样失败忽略，下轮再试 */ }
        }, 2000)
        // once:true 只在真正 unload 时消费，所以必须同时带 signal：否则每换一次背景
        // 就往 window 上再挂一个空监听（旧写法漏了 signal，长会话＋频繁换图会攒几百个）。
        window.addEventListener('pagehide', () => {
            clearInterval(this._dynamicTimer); this._dynamicTimer = null
        }, { once: true, signal: this.abort.signal })
    }

    // 窗口尺寸/排版变化后，用当前图像重新计算并平滑过渡到新的遮罩强度
    recomputeReadability () {
        if (!this.currentImage || !this.currentPlan) return
        this._lastDynLum = null
        const plan = this.acceptThemeSwitch(computeReadability({
            image: this.currentImage,
            rect: this.readRect(),
            vw: window.innerWidth,
            vh: window.innerHeight,
            forcedTheme: this.settings.readability.theme === 'auto' ? null : this.settings.readability.theme,
            maskBias: this.settings.readability.maskBias,
        }))
        this.currentPlan = plan
        this.applyPlan(plan, { instant: false })
        this.dispatchEvent(new CustomEvent('scenechange', {
            detail: { refId: this.currentRef, name: this.refName(this.currentRef), readability: plan },
        }))
    }
}
