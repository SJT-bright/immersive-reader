// 唱机几何与运动：固定俯视 2.5D。小轴放到唱片上播放，离开暂停。
// 盘面旋转由 rAF 按时间积分；高光/投影不随盘转。唱臂绕固定支点、臂长不变。

export const VIEW = Object.freeze({ w: 228, h: 176 })
export const DISC = Object.freeze({ x: 72, y: 88, r: 68, label: 68 / 3 })
export const REST = Object.freeze({ x: 176, y: 28 })
export const PIVOT = Object.freeze({ x: 214, y: 16 })
export const PUCK_R = 12
export const GROOVE_OUTER = DISC.r - 5
export const GROOVE_INNER = DISC.label + 5
export const ARM_LENGTH = 134
export const DEG_PER_SEC = (33 + 1 / 3) * 6 // 33⅓ RPM = 200°/s

export function puckOnDisc (x, y, disc = DISC) {
    return Math.hypot(Number(x) - disc.x, Number(y) - disc.y) <= disc.label
}

export function snapPuck (x, y, disc = DISC, rest = REST) {
    const on = Math.hypot(Number(x) - disc.x, Number(y) - disc.y)
    const off = Math.hypot(Number(x) - rest.x, Number(y) - rest.y)
    return on <= off ? { x: disc.x, y: disc.y, on: true } : { x: rest.x, y: rest.y, on: false }
}

export function clampPuck (x, y, width = VIEW.w, height = VIEW.h) {
    const m = PUCK_R + 2
    return {
        x: Math.max(m, Math.min(width - m, Number(x) || 0)),
        y: Math.max(m, Math.min(height - m, Number(y) || 0)),
    }
}

export function clamp (v, lo, hi) {
    return Math.max(lo, Math.min(hi, v))
}

// CSS rotate：0° 指向下方（+y），顺时针为正。
export function angleDown (from, to) {
    return Math.atan2(to.x - from.x, to.y - from.y) * 180 / Math.PI
}

export function pointAt (from, angleDeg, length) {
    const a = angleDeg * Math.PI / 180
    return { x: from.x + Math.sin(a) * length, y: from.y + Math.cos(a) * length }
}

// |X-C|=r 且 |X-P|=L 的交点，取更靠右的那一个（唱臂从右上方伸入）。
export function grooveStylus (radius, disc = DISC, pivot = PIVOT, length = ARM_LENGTH) {
    const dx = pivot.x - disc.x, dy = pivot.y - disc.y
    const d = Math.hypot(dx, dy)
    const r = Number(radius)
    const a = (r * r - length * length + d * d) / (2 * d)
    const h2 = r * r - a * a
    if (!(h2 >= 0) || d < 1e-6) return null
    const h = Math.sqrt(h2)
    const mx = disc.x + a * dx / d, my = disc.y + a * dy / d
    const px = -dy / d, py = dx / d
    const p1 = { x: mx + h * px, y: my + h * py }
    const p2 = { x: mx - h * px, y: my - h * py }
    return p1.x >= p2.x ? p1 : p2
}

export const OUTER_STYLUS = grooveStylus(GROOVE_OUTER)
export const INNER_STYLUS = grooveStylus(GROOVE_INNER)
export const REST_ANGLE = -28
export const PLAY_START_ANGLE = OUTER_STYLUS ? angleDown(PIVOT, OUTER_STYLUS) : 18
export const PLAY_END_ANGLE = INNER_STYLUS ? angleDown(PIVOT, INNER_STYLUS) : 38

export function armAngleForProgress (progress) {
    const t = clamp(Number(progress) || 0, 0, 1)
    return PLAY_START_ANGLE + (PLAY_END_ANGLE - PLAY_START_ANGLE) * t
}

export function stylusAtProgress (progress) {
    return pointAt(PIVOT, armAngleForProgress(progress), ARM_LENGTH)
}

export function stylusOnGrooves (point, disc = DISC) {
    const d = Math.hypot(point.x - disc.x, point.y - disc.y)
    return d >= GROOVE_INNER - 0.6 && d <= GROOVE_OUTER + 0.6
}

export function approach (current, target, dt, tau) {
    if (!(tau > 0)) return target
    const k = 1 - Math.exp(-Math.max(0, dt) / tau)
    return current + (target - current) * k
}

export function stepSpin (angle, omega, targetOmega, dt, upTime = 0.75, downTime = 1) {
    const t = clamp(dt, 0, 0.05)
    const span = targetOmega > omega ? upTime : downTime
    const accel = DEG_PER_SEC / Math.max(0.05, span)
    let next = omega
    if (next < targetOmega) next = Math.min(targetOmega, next + accel * t)
    else if (next > targetOmega) next = Math.max(targetOmega, next - accel * t)
    if (targetOmega === 0 && Math.abs(next) < 0.08) next = 0
    return { angle: angle + next * t, omega: next }
}

export function shortLabel (name) {
    const raw = String(name || '').replace(/\.[a-z0-9]{1,5}$/i, '').trim()
    if (!raw) return 'SIDE A'
    return raw.length <= 10 ? raw : raw.slice(0, 9) + '…'
}

export function paintGrooves (canvas) {
    const s = canvas.width
    const ctx = canvas.getContext('2d')
    const cx = s / 2, cy = s / 2
    const rDisc = s / 2 - 1
    const rLabel = rDisc / 3
    ctx.clearRect(0, 0, s, s)
    ctx.fillStyle = '#161616'
    ctx.beginPath()
    ctx.arc(cx, cy, rDisc, 0, Math.PI * 2)
    ctx.fill()
    const rim = ctx.createRadialGradient(cx, cy, rDisc - 6, cx, cy, rDisc)
    rim.addColorStop(0, 'rgba(0,0,0,0)')
    rim.addColorStop(0.65, 'rgba(40,40,42,.35)')
    rim.addColorStop(1, 'rgba(210,210,214,.28)')
    ctx.fillStyle = rim
    ctx.beginPath()
    ctx.arc(cx, cy, rDisc, 0, Math.PI * 2)
    ctx.fill()
    for (let r = rLabel + 8; r < rDisc - 3; r += 0.85) {
        const u = (r - rLabel) / (rDisc - rLabel)
        const lead = u < 0.08 || u > 0.93 ? 0.35 : 1
        const wobble = 0.55 + 0.45 * Math.sin(r * 0.41) * Math.sin(r * 0.11)
        const alpha = 0.045 * lead * wobble
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255,255,255,${alpha})`
        ctx.lineWidth = 0.7
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(cx, cy, r + 0.38, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(0,0,0,${alpha * 1.4})`
        ctx.lineWidth = 0.55
        ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(cx, cy, rLabel + 6.5, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(0,0,0,.35)'
    ctx.lineWidth = 3
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(cx, cy, rDisc - 2.2, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,.14)'
    ctx.lineWidth = 1.2
    ctx.stroke()
}

// 落针物理：重力加速度（lift 归一单位 1=完全抬起），单次回弹恢复系数，
// 悬停时长与 seek 检测阈值。33⅓ RPM 的主轴转频用于沟槽偏心微摆。
const DROP_G = 19.5
const DROP_BOUNCE = 0.32
const DROP_HOLD = 0.12
const SEEK_REDROP = 10
const SPINDLE_HZ = (33 + 1 / 3) / 60

export class VinylMotion {
    constructor ({ stage, player }) {
        this.stage = stage
        this.player = player
        this.reduced = matchMedia('(prefers-reduced-motion: reduce)')
        this.angle = 0
        this.omega = 0
        this.arm = REST_ANGLE
        this.armVel = 0
        this.lift = 1
        this.dropHold = 0
        this.sway = 0
        this.swayT = 0
        this.place = 0
        this.armPhase = 'rest'
        this.visual = 'idle'
        this.wantPlay = false
        this.trackId = null
        this.lastTs = 0
        this.raf = 0
        this.abort = new AbortController()
        const opts = { signal: this.abort.signal }
        const audio = player.audio
        audio.addEventListener('play', () => this.onAudio('play'), opts)
        audio.addEventListener('playing', () => this.onAudio('playing'), opts)
        audio.addEventListener('pause', () => this.onAudio('pause'), opts)
        audio.addEventListener('waiting', () => this.onAudio('waiting'), opts)
        audio.addEventListener('ended', () => this.onAudio('ended'), opts)
        audio.addEventListener('error', () => this.onAudio('error'), opts)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                cancelAnimationFrame(this.raf)
                this.raf = 0
                this.lastTs = 0
            } else this.wake()
        }, opts)
        this.reduced.addEventListener('change', () => this.wake(), opts)
        this.paint()
        this.apply()
        this.wake()
    }

    paint () {
        const canvas = this.stage.querySelector('.deck-grooves')
        if (!canvas) return
        const size = 512
        canvas.width = size
        canvas.height = size
        paintGrooves(canvas)
    }

    onAudio (kind) {
        if (kind === 'play' || kind === 'playing') {
            this.wantPlay = true
            this.visual = kind === 'playing' ? 'playing' : 'starting'
            this.setHint('')
        } else if (kind === 'waiting') {
            this.visual = 'buffering'
        } else if (kind === 'pause') {
            this.wantPlay = false
            this.visual = this.player.currentId ? 'pausing' : 'idle'
        } else if (kind === 'ended') {
            this.wantPlay = false
        } else if (kind === 'error') {
            this.wantPlay = false
            this.visual = 'error'
            this.setHint('点击播放')
        }
        this.wake()
    }

    noteState (st) {
        if (st.currentId !== this.trackId) {
            const prev = this.trackId
            this.trackId = st.currentId
            if (st.currentId && st.playing && !this.reduced.matches) this.place = 1
            if (prev && (this.armPhase === 'on-record' || this.armPhase === 'dropping')) this.armPhase = 'to-play'
        }
        if (!st.currentId) {
            this.trackId = null
            this.wantPlay = false
            this.visual = 'idle'
        }
        this.setLabel(st.currentName, st.index)
        if (st.playing) this.wantPlay = true
        this.wake()
    }

    setLabel (name, index, side) {
        const text = this.stage.querySelector('.deck-label-name')
        const sideEl = this.stage.querySelector('.deck-side')
        if (text) text.textContent = shortLabel(name)
        if (sideEl) sideEl.textContent = side || ((index || 0) % 2 === 0 ? 'A' : 'B')
    }

    // QQ/网易云接管时唱机转为「外部播放」展示态：盘面停转、唱臂归位，不再维持本地暂停姿势
    onRemote () {
        this.wantPlay = false
        if (this.visual !== 'idle') {
            this.visual = 'idle'
            this.armPhase = 'to-rest'
        }
        this.wake()
    }

    setHint (text) {
        const el = this.stage.querySelector('.deck-hint')
        if (!el) return
        el.hidden = !text
        el.textContent = text || ''
    }

    needsTick () {
        if (this.reduced.matches) return this.place > 0.002 || this.armPhase !== 'rest'
        return this.omega > 0.05 || this.wantPlay || this.visual === 'pausing' || this.visual === 'buffering'
            || this.place > 0.002 || this.armPhase !== 'rest' || this.lift < 0.98
    }

    wake () {
        if (this.raf || document.hidden) return
        this.lastTs = 0
        this.raf = requestAnimationFrame(t => this.frame(t))
    }

    frame (now) {
        this.raf = 0
        const dt = this.lastTs ? clamp((now - this.lastTs) / 1000, 0, 0.05) : 1 / 60
        this.lastTs = now
        const st = this.player.getState()
        const reduced = this.reduced.matches
        const live = st.playing && !st.waiting
        const targetOmega = reduced || !live ? 0 : DEG_PER_SEC
        const spun = stepSpin(this.angle, this.omega, targetOmega, dt, 0.72, 1)
        this.angle = spun.angle
        this.omega = spun.omega
        this.place = reduced ? 0 : approach(this.place, 0, dt, 0.36)
        this.stepArm(dt, st, live)
        this.apply()
        if (this.needsTick()) this.raf = requestAnimationFrame(t => this.frame(t))
    }

    stepArm (dt, st, live) {
        const progress = st.duration > 0 ? clamp(st.time / st.duration, 0, 1) : 0
        const playA = armAngleForProgress(progress)
        const keepPose = this.visual === 'pausing' || this.visual === 'buffering'
        if (live || this.visual === 'starting') {
            if (this.armPhase === 'rest' || this.armPhase === 'to-rest') this.armPhase = 'to-play'
        } else if (this.armPhase === 'on-record' || this.armPhase === 'to-play' || this.armPhase === 'dropping') {
            // 暂停不打断进行中的摆臂/落针：动作走完后由 on-record 的暂停目标半抬保持
            if (!keepPose) this.armPhase = 'to-rest'
        }
        if (this.reduced.matches) {
            this.arm = live || keepPose ? playA : REST_ANGLE
            this.lift = live ? 0 : keepPose ? 0.45 : 1
            this.sway = 0
            if (live) this.armPhase = 'on-record'
            else if (!keepPose) this.armPhase = 'rest'
            return
        }
        // 沟槽偏心微摆：盘转起来后针尖随主轴转频轻晃，幅值随转速渐进
        if (this.omega > 4) {
            this.swayT += dt
            this.sway = 0.14 * (this.omega / DEG_PER_SEC) * Math.sin(SPINDLE_HZ * Math.PI * 2 * this.swayT)
        } else {
            this.sway = approach(this.sway, 0, dt, 0.1)
        }
        if (this.armPhase === 'to-play') {
            this.lift = approach(this.lift, 1, dt, 0.11)
            if (this.lift > 0.72) this.arm = approach(this.arm, playA, dt, 0.26)
            if (Math.abs(this.arm - playA) < 1.4 && this.lift > 0.84) {
                // 摆位完成：先悬停瞄准，再松开升降机构
                this.armPhase = 'dropping'
                this.armVel = 0
                this.dropHold = DROP_HOLD
            }
        } else if (this.armPhase === 'dropping') {
            this.arm = approach(this.arm, playA, dt, 0.18)
            if (this.dropHold > 0) {
                this.dropHold -= dt
            } else {
                // 重力落针：加速下落，触底回弹一次再停稳
                this.armVel += DROP_G * dt
                this.lift -= this.armVel * dt
                if (this.lift <= 0) {
                    this.lift = 0
                    this.armVel = this.armVel > 1.2 ? -this.armVel * DROP_BOUNCE : 0
                    if (this.armVel === 0) this.armPhase = 'on-record'
                }
            }
        } else if (this.armPhase === 'on-record') {
            // 大幅跳变（拖动进度条/单曲循环）不能横扫唱片：抬起重新落针
            if (Math.abs(playA - this.arm) > SEEK_REDROP) {
                this.armPhase = 'to-play'
            } else {
                this.arm = approach(this.arm, playA, dt, 0.4)
                this.lift = approach(this.lift, this.visual === 'buffering' || this.visual === 'pausing' ? 0.42 : 0, dt, 0.12)
            }
        } else if (this.armPhase === 'to-rest') {
            this.lift = approach(this.lift, 1, dt, 0.11)
            if (this.lift > 0.82) this.arm = approach(this.arm, REST_ANGLE, dt, 0.26)
            if (Math.abs(this.arm - REST_ANGLE) < 1.2 && this.lift > 0.9) this.armPhase = 'rest'
        } else {
            this.arm = approach(this.arm, REST_ANGLE, dt, 0.2)
            this.lift = approach(this.lift, 1, dt, 0.14)
        }
    }

    apply () {
        const el = this.stage
        el.style.setProperty('--spin', (this.angle % 360) + 'deg')
        el.style.setProperty('--arm-angle', (this.arm + this.sway) + 'deg')
        el.style.setProperty('--arm-lift', (this.lift * -5) + 'px')
        el.style.setProperty('--place-y', (this.place * -9) + 'px')
        el.style.setProperty('--place-shadow', String(0.22 + (1 - this.place) * 0.5))
        el.dataset.visual = this.visual
        el.dataset.arm = this.armPhase
    }

    destroy () {
        this.abort.abort()
        cancelAnimationFrame(this.raf)
        this.raf = 0
    }
}
