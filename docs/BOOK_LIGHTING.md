# 书本光影参数与实现

适用：2026-09-22 起的 `builtin:fp-*` 双页书。实现：[book-lighting.js](../js/book-lighting.js)，样式：[experience.css](../css/experience.css)。本页替代此前在 CSS 中单独叠加中缝亮暗色带的做法。

## 设计与边界

纸面光照绘在独立的 ::before 层（z-index:0），书封及投影留在下层（z-index:-1），文字在上层（z-index:1）。不能把光照放在父背景、再在负 z-index 子层画一整块实色书封：带 transform 的书体会建立堆叠上下文，子层仍会盖住父背景。

主光从场景的亮处照来，纸面曲率决定受光；窄装订槽遮住一部分入射光，同时减少环境补光。底部紧贴的接触阴影与较宽的柔和投影分开，投影指向光源的反方向。采用哑光纸，不添加镜面白边、随机噪声或循环闪光。

这是**纸面横截面的 2.5D 光照近似**：真实 DOM 正文继续由 foliate 排版，书本整体角度不变，上下页缘用同一高度场投影生成微小弧线；没有把正文贴到 WebGL 曲面上，也不是对背景照片进行房间光线追踪。场景光向按画面设计指定，未测量 HDR 环境照明。底部椭圆投影是参数化近似，不是逐像素场景阴影求交。

## 参数

修改 `BOOK_LIGHTING` 调全局默认；`BOOK_LIGHT_SCENES` 是四个场景的覆盖值。参数不会写入用户书库。当前 x 向右、y 向下、z 朝读者；横截面以毫米计，整本展开宽 280mm，再按屏幕宽度等比换算。

| 参数 | 默认值 | 作用 |
|---|---:|---|
| `light` | `[-0.85,-0.75,1.10]` | 左上前方主光；z 必须正。改 x 的正负会反转受光和投影方向 |
| `key` / `ambient` | `0.70` / `0.42` | 主光与环境补光；环境补光避免纸面变成脏黑块 |
| `sourceRadius` | `0.30` | 相对光源尺寸；越大越柔和，不是单独加深阴影 |
| `pageCamber` | `12mm` | 两片纸页的微弧面高度 |
| `gutterDepth` / `gutterRadius` | `3.8mm` / `6mm` | 中缝凹入深度与渐变范围 |
| `occlusion` | `0.38` | 装订槽对环境光的遮蔽强度，不覆盖正文墨色 |
| `edgeProjection` | `0.15` | 同一纸面高度场投影到上下页缘的比例；受现有留白约束 |
| `clearance` | `5.5mm` | 有效投影间距；同时影响偏移和半影宽度 |
| `contactOpacity` / `castOpacity` | `0.28` / `0.28` | 贴地窄影与扩散投影基准强度；投影还按主光/补光比例调整 |
| `paper` / `warmth` | `[250,246,234]` / `[1,.985,.95]` | 纸色与主光相对色温 |

先调光向，再调弧度/中缝，最后调光源尺寸与阴影强度。不要另外加一个与光向无关的 `box-shadow`，否则又会出现两套矛盾光影。

## 函数与计算

- `paperHeight(x)`：两页正弦平方微拱面，叠加装订处高斯凹槽。
- `samplePaper(x)`：由高度差求法线 `N = normalize(-dz/dx, 0, 1)`；有限面积光源取 9 个固定样本，计算 `max(0, N·L)`，用截面射线测试剔除被纸面遮住的光。环境遮蔽只衰减 ambient 分量。
- 颜色在线性光空间计算后转回 sRGB，避免直接用 RGB 乘法造成污灰渐变。正文不参与这层着色。
- `buildBookLighting(width, overrides)`：在中缝密集采样、平缓纸面稀疏采样，生成连续 CSS 渐变与微弧纸面/书口轮廓；同一光向给出 `offset = -light.xy / light.z × clearance`，半影随光源大小与间距增加。
- `createBookLighting(host)`：场景或尺寸变化才重算，`ResizeObserver` 与 `requestAnimationFrame` 合并更新；场景/宽度没变不重算。没有持续逐帧渲染。

```js
const lighting = buildBookLighting(1280, {
    light: [-0.85, -0.75, 1.10],
    sourceRadius: 0.30,
    gutterDepth: 3.8,
})
for (const [name, value] of Object.entries(lighting.vars)) {
    host.style.setProperty(name, value)
}
```

## 验证入口

`node --test tests/book-lighting.test.mjs` 检查光向翻转、光源大小/间距变化、数值有效与阅读区域明度。浏览器验证和最终图片回执见 [VERIFICATION.md](../VERIFICATION.md) 。模型测试通过不等于视觉真实度得到用户认可。

当前视觉边界：窄屏回执确认页缘浅弧、中缝及接触/扩散投影；桌面回执确认纸面分区明暗和柔影，但认为上下页缘仍近乎平直。保留现有可选正文和轻微轮廓起伏，不把这次交付描述为完整3D曲面文字或照片级仿真。
