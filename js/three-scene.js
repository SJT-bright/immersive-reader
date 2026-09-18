// 程序化动态场景：纯 2D Canvas 渲染（v2.0.0 重写，不再依赖 three.js/WebGL）。
// 背景：原 three.js WebGL 离屏管线需要第二个 GL 上下文 + 600KB three.min.js，
// 在 WebGL 被禁用/上下文受限的环境里构造失败会被上层 catch 吞掉——用户点击 3D 背景
// 毫无反馈（「点开点不了」）。2D 版消除整类失败：任何支持 canvas 的浏览器都能渲染，
// 且仍是「离屏 canvas → 现有场景管线（雨窗玻璃纹理/可读性采样/交叉渐变）」的同构接入。
//
// 导出 API 与旧版完全一致：isThreeScene / threeSceneName / ThreeSceneRenderer(start/stop)，
// 另新增 snapshot() 供场景面板生成真实缩略图（旧版只有「◈ 3D」文字占位）。
//
// 视觉对照旧 WebGL 版逐项移植：
// - 群山黎明：三段黎明渐变天穹 + 太阳光晕 + 三层山脊（雾色预混合空气透视 0.68/0.38/0.12）
//   + 地平线雾带；山脊曲线沿用 ridgeGeometry 的多正弦公式（seed 0/2.1/4.2，振幅 30/38/46），
//   相机横移 sin(t*.05)*3 → 三层按距离比例视差。
// - 极光夜空：程序化极光 shader 逐像素移植（双带 + 帘状褶皱 + 帘脊高光，均值≈1 不过曝），
//   在 192×108 离屏上以 ImageData 计算后放大合成（'lighter' 加色，放大即柔光）；
//   星点（种子随机 + 闪烁）、两层雪山剪影（seed 1.3/3.7）、冰湖倒影。

const SCENE_W = 960, SCENE_H = 540
const FOV_HALF_TAN = Math.tan((55 / 2) * Math.PI / 180) // 旧 PerspectiveCamera(55°)

// 旧 ridgeGeometry 的山脊高度曲线：多正弦叠加，seed 让每层相位错开
function ridgeF (seed) {
    return x =>
        Math.sin(x * .045 + seed * 7) * .55 +
        Math.sin(x * .013 + seed * 3.1 + 2.1) * .95 +
        Math.sin(x * .11 + seed) * .18 +
        Math.sin(x * .023 + seed * 1.7) * .45
}

// 世界坐标 → 屏幕坐标。相机位于 (camX, 8, 20) 朝 -z 看；layer.d 是相机到图层的距离。
// 竖直：可见高度 = 2·d·tan(fov/2) 铺满 H；水平：按宽高比换算。
function makeProjector (layer) {
    const spanY = 2 * layer.d * FOV_HALF_TAN
    const spanX = spanY * (SCENE_W / SCENE_H)
    return {
        pxPerX: SCENE_W / spanX,
        x (wx, camX) { return SCENE_W / 2 + (wx - camX) * this.pxPerX },
        y (wy) { return SCENE_H / 2 - (wy - 8) * (SCENE_H / spanY) },
        worldSpanX: spanX / 2,
    }
}

// 画一层山脊剪影：沿屏幕逐列采样山脊高度曲线，路径向下延伸裙边到底部
function drawRidge (ctx, layer, camX) {
    const proj = makeProjector(layer)
    const f = ridgeF(layer.seed)
    ctx.beginPath()
    ctx.moveTo(0, SCENE_H)
    for (let sx = 0; sx <= SCENE_W; sx += 4) {
        const wx = (sx - SCENE_W / 2) / proj.pxPerX + camX
        const wy = layer.base + layer.amplitude * (.5 + .5 * f(wx))
        ctx.lineTo(sx, proj.y(wy))
    }
    ctx.lineTo(SCENE_W, SCENE_H)
    ctx.closePath()
    ctx.fillStyle = layer.color
    ctx.fill()
}

// GLSL smoothstep / mix / 分形噪声的 JS 移植（极光逐像素计算用）
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const mix = (a, b, t) => a + (b - a) * t
function vnoise (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y)
    const xf = x - xi, yf = y - yi
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf)
    const h = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s) }
    return mix(mix(h(xi, yi), h(xi + 1, yi), u), mix(h(xi, yi + 1), h(xi + 1, yi + 1), u), v)
}

// 种子伪随机（星点布局需要确定性，每帧一致）
function mulberry32 (seed) {
    let a = seed >>> 0
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0
        let t = Math.imul(a ^ (a >>> 15), 1 | a)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// 极光离屏：192×108 ImageData 逐像素算「极光亮度」（col - base），主画布 'lighter' 放大叠加。
// 低分辨率计算 + 双线性放大本身就是柔和辉光，避免逐列渐变的每帧对象开销。
class AuroraLayer {
    constructor () {
        this.w = 192; this.h = 108
        this.canvas = document.createElement('canvas')
        this.canvas.width = this.w; this.canvas.height = this.h
        this.ctx = this.canvas.getContext('2d')
        this.image = this.ctx.createImageData(this.w, this.h)
    }
    // d.y 映射：屏幕顶部 v=0 → 天顶 h≈1，地平线 v≈0.56 → h=0
    draw (t) {
        const data = this.image.data
        for (let py = 0; py < this.h; py++) {
            const v = py / this.h
            const dy = (0.56 - v) * 1.75
            for (let px = 0; px < this.w; px++) {
                const u = px / this.w
                const dx = (u - 0.5) * 2.3
                const dz = v * 1.2 - 0.6
                // 主/副极光带（正偏置：任一时刻至少一条处于波峰）+ 帘状褶皱 + 帘脊高光
                const wob = vnoise(dx * 2.2 + t * .05, dz * 2.2 - t * .03)
                const curtain = .72 + .28 * Math.sin(dx * 36 + wob * 8 + t * .12) * Math.sin(dx * 19 - t * .07 + wob * 4)
                const curtain2 = .8 + .2 * Math.sin(dx * 26 - wob * 5 + t * .09) * Math.sin(dx * 11 + t * .05)
                const ray = smoothstep(.62, 1, curtain)
                const band = .55 + .28 * Math.sin(dx * 4.5 + t * .4) + .17 * Math.sin(dz * 1.9 - t * .27)
                const band2 = .45 + .3 * Math.sin(dx * 3.1 - t * .23 + 1.7) + .2 * Math.sin(dz * 1.5 + t * .31 + .6)
                const win = smoothstep(.1, .45, dy) * (1 - smoothstep(.75, .98, dy))
                const aur = smoothstep(.3, .8, band) * win * curtain
                const aur2 = smoothstep(.42, .88, band2) * win * .6 * curtain2
                const ca = .5 + .5 * Math.sin(t * .2 + dx * 2)   // 绿⇄紫摆动
                const cb = .5 + .5 * Math.sin(t * .17 + dz * 1.3)
                const o = (py * this.w + px) * 4
                data[o] = Math.max(0, mix(.15, .5, ca) * aur * .95 + mix(.5, .15, cb) * aur2 * .55 + mix(.15, .5, ca) * aur * ray * .28) * 255
                data[o + 1] = Math.max(0, mix(.85, .22, ca) * aur * .95 + mix(.22, .85, cb) * aur2 * .55 + mix(.85, .22, ca) * aur * ray * .28) * 255
                data[o + 2] = Math.max(0, mix(.55, .75, ca) * aur * .95 + mix(.75, .55, cb) * aur2 * .55 + mix(.55, .75, ca) * aur * ray * .28) * 255
                data[o + 3] = 255
            }
        }
        this.ctx.putImageData(this.image, 0, 0)
    }
}

function makeStars (count, seed) {
    const rand = mulberry32(seed)
    return Array.from({ length: count }, () => ({
        x: rand() * SCENE_W,
        y: rand() * SCENE_H * .62,
        r: .5 + rand() * 1.1,
        a: .3 + rand() * .7,
        phase: rand() * Math.PI * 2,
    }))
}

const SCENES = {
    'three:mountains-dawn': {
        name: '群山黎明 · 动态',
        build () {
            return {
                ridges: [
                    // 远→近；color = 山色向雾色 #d9b28c 预混合（空气透视，比例同旧版 0.68/0.38/0.12）
                    { d: 140, base: -26, amplitude: 30, seed: 0, color: '#c0a091' },
                    { d: 105, base: -26, amplitude: 38, seed: 2.1, color: '#8c787b' },
                    { d: 75, base: -26, amplitude: 46, seed: 4.2, color: '#4c4352' },
                ],
            }
        },
        draw (ctx, state, t) {
            const camX = Math.sin(t * .05) * 3
            // 三段黎明渐变天穹：深蓝顶 → 玫瑰霞中 → 金色地平线
            const sky = ctx.createLinearGradient(0, 0, 0, SCENE_H)
            sky.addColorStop(0, '#24425f'); sky.addColorStop(.19, '#2c4a63')
            sky.addColorStop(.41, '#c97f6a'); sky.addColorStop(.56, '#f2c078')
            sky.addColorStop(1, '#f6c983')
            ctx.fillStyle = sky; ctx.fillRect(0, 0, SCENE_W, SCENE_H)
            // 太阳 + 光晕（世界坐标 (-38,16,-160) 投影）
            const sunD = 180, spanY = 2 * sunD * FOV_HALF_TAN
            const sunX = SCENE_W / 2 + (-38 - camX * .55) * (SCENE_W / (spanY * SCENE_W / SCENE_H))
            const sunY = SCENE_H / 2 - (16 - 8) * (SCENE_H / spanY)
            const halo = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 70)
            halo.addColorStop(0, 'rgba(255,217,160,.55)'); halo.addColorStop(1, 'rgba(255,217,160,0)')
            ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(sunX, sunY, 70, 0, Math.PI * 2); ctx.fill()
            ctx.fillStyle = '#ffe9c4'; ctx.beginPath(); ctx.arc(sunX, sunY, 26, 0, Math.PI * 2); ctx.fill()
            // 地平线雾带（旧版 z=-150 半透明平面）：柔化远山与天空交界
            const mist = ctx.createLinearGradient(0, SCENE_H * .40, 0, SCENE_H * .66)
            mist.addColorStop(0, 'rgba(217,178,140,0)'); mist.addColorStop(.5, 'rgba(217,178,140,.24)')
            mist.addColorStop(1, 'rgba(217,178,140,0)')
            ctx.fillStyle = mist; ctx.fillRect(0, SCENE_H * .40, SCENE_W, SCENE_H * .26)
            // 三层山脊（近的最后画，覆盖在上）
            for (const layer of state.ridges) drawRidge(ctx, layer, camX * (75 / layer.d))
        },
    },
    'three:aurora-night': {
        name: '极光夜空 · 动态',
        build () {
            return {
                aurora: new AuroraLayer(),
                stars: makeStars(130, 20260917),
                ridges: [
                    // 雾色 #101c30 预混合 0.5 / 0.18（同旧版）
                    { d: 130, base: -30, amplitude: 34, seed: 1.3, color: '#1f2f44' },
                    { d: 90, base: -30, amplitude: 44, seed: 3.7, color: '#18293d' },
                ],
            }
        },
        draw (ctx, state, t) {
            const camX = Math.sin(t * .03) * 2
            // 夜空穹顶：天顶略亮的深蓝渐变（对应 shader base mix）
            const sky = ctx.createLinearGradient(0, 0, 0, SCENE_H)
            sky.addColorStop(0, '#091426'); sky.addColorStop(.6, '#081020'); sky.addColorStop(1, '#050c18')
            ctx.fillStyle = sky; ctx.fillRect(0, 0, SCENE_W, SCENE_H)
            // 极光：逐像素算好后以加色放大叠加（低分辨率 → 天然柔光）
            state.aurora.draw(t)
            ctx.save()
            ctx.globalCompositeOperation = 'lighter'
            ctx.imageSmoothingEnabled = true
            ctx.drawImage(state.aurora.canvas, 0, 0, SCENE_W, SCENE_H * .62)
            ctx.restore()
            // 星点（极光之上、山之后）
            for (const s of state.stars) {
                ctx.globalAlpha = s.a * (.72 + .28 * Math.sin(t * 1.7 + s.phase))
                ctx.fillStyle = '#cfe0ff'
                ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill()
            }
            ctx.globalAlpha = 1
            // 两层雪山剪影
            for (const layer of state.ridges) drawRidge(ctx, layer, camX * (90 / layer.d))
            // 冰湖：山前反光面 + 极光倒影 + 微光涟漪
            const lakeTop = SCENE_H * .52
            const lake = ctx.createLinearGradient(0, lakeTop, 0, SCENE_H)
            lake.addColorStop(0, '#14283c'); lake.addColorStop(1, '#0b1826')
            ctx.fillStyle = lake; ctx.fillRect(0, lakeTop, SCENE_W, SCENE_H - lakeTop)
            ctx.save()
            ctx.beginPath(); ctx.rect(0, lakeTop, SCENE_W, SCENE_H - lakeTop); ctx.clip()
            ctx.globalAlpha = .16
            ctx.translate(0, lakeTop * 2); ctx.scale(1, -1)
            ctx.drawImage(state.aurora.canvas, 0, 0, SCENE_W, SCENE_H * .62)
            ctx.restore()
            ctx.save()
            ctx.globalAlpha = .05 + .03 * Math.sin(t * .5)
            ctx.strokeStyle = '#7fb4d8'
            for (let i = 0; i < 5; i++) {
                const y = lakeTop + 12 + i * 18 + Math.sin(t * .7 + i * 2.1) * 3
                ctx.beginPath(); ctx.moveTo(SCENE_W * .12, y); ctx.lineTo(SCENE_W * .88, y); ctx.stroke()
            }
            ctx.restore()
        },
    },
}

export const THREE_SCENE_IDS = Object.keys(SCENES)
export const isThreeScene = id => THREE_SCENE_IDS.includes(id)
export const threeSceneName = id => SCENES[id]?.name || id

export class ThreeSceneRenderer {
    constructor () {
        // 公开画布保持 960×540 固定内部分辨率（纹理采样与可读性采样友好，与旧版一致）
        this.canvas = document.createElement('canvas')
        this.canvas.width = SCENE_W; this.canvas.height = SCENE_H
        this.ctx = this.canvas.getContext('2d')
        this.active = null
        this.raf = 0
        this.startAt = 0
        this._last = 0
        this._snaps = new Map() // sceneId@尺寸 → dataURL（缩略图缓存）
    }

    // 启动指定场景的离屏渲染；返回 canvas 供管线当 image 源使用（同步渲染首帧）
    start (sceneId) {
        const def = SCENES[sceneId]
        if (!def) return null
        this.stop()
        this.active = { def, data: def.build() }
        this.startAt = performance.now()
        this._last = 0
        this.active.def.draw(this.ctx, this.active.data, 0)
        const loop = now => {
            if (!this.active) return
            // ~30fps 足够氛围动画（慢速视差/极光漂移），后台标签页 rAF 暂停时自然停帧
            if (!document.hidden && now - this._last >= 31) {
                this._last = now
                this.active.def.draw(this.ctx, this.active.data, (now - this.startAt) / 1000)
            }
            this.raf = requestAnimationFrame(loop)
        }
        this.raf = requestAnimationFrame(loop)
        return this.canvas
    }

    stop () {
        if (this.raf) cancelAnimationFrame(this.raf)
        this.raf = 0
        this.active = null
    }

    // 渲染单帧缩略图（不干扰进行中的动画：独立临时画布 + 独立场景状态）
    snapshot (sceneId, w = 240, h = 135) {
        const def = SCENES[sceneId]
        if (!def) return ''
        const key = `${sceneId}@${w}x${h}`
        if (this._snaps.has(key)) return this._snaps.get(key)
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        const x = c.getContext('2d')
        x.scale(w / SCENE_W, h / SCENE_H)
        def.draw(x, def.build(), 6) // t=6：极光带已展开、黎明光已就位
        const url = c.toDataURL('image/jpeg', 0.85)
        this._snaps.set(key, url)
        return url
    }
}
