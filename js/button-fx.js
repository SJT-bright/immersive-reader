// 全局按钮动效（v1.0.0）：每次点击触发「虚化渐入」高光脉冲。
// 悬停浮动在 css/glass-ui.css（hover 上浮 + 阴影加深）；这里只负责点击脉冲的类切换，
// 因为 :active 只覆盖按住期间，无法表达「每点击一次播放一次」的语义。
// 捕获阶段委托：面板/停靠栏/动态插入的按钮无需逐个绑定；reduce-motion 由 CSS 侧关闭。
export function installButtonFx () {
    document.addEventListener('click', e => {
        const button = e.target.closest('button')
        if (!button || button.disabled) return
        button.classList.remove('is-clicked')
        void button.offsetWidth // 强制同步重排，连续点击也能重启动画
        button.classList.add('is-clicked')
    }, true)
    document.addEventListener('animationend', e => {
        if (e.target instanceof Element && e.animationName === 'btn-veil') e.target.classList.remove('is-clicked')
    }, true)
}
