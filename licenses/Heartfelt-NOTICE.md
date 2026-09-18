# Heartfelt 雨滴着色器

原作者：Martijn Steinrucken（BigWings），2017。原作：https://www.shadertoy.com/view/ltffzl

`js/rain-shaders.js` 中 N13、Saw、StaticDrops、DropLayer2、Drops 为 Heartfelt 核心方程的衍生。实现取自只读 Amado 的 GLSL 版本，Amado commit：978333a5e5f29b5c1753839240a19f445a71777a。Amado 的 MIT 声明完整保留在 Amado-MIT.txt；该声明不能替代底层作品的许可。

Heartfelt 的公开移植代码明确标注 CC BY-NC-SA 3.0：
https://github.com/yumayanagisawa/Unity-Raindrops/blob/master/Raindrop/Assets/Raindrop.shader
原始 Shadertoy 页面本轮访问失败，因此以公开移植的逐文件标注作为许可依据，不声称已从原始页面重新核验。

本项目雨滴着色器衍生文件按 Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported 分发。许可完整 URI：https://creativecommons.org/licenses/by-nc-sa/3.0/legalcode.en 。分享时保留署名与相同许可，仅限非商业使用；不将 foliate-js 等其他独立组件改成此许可。

修改：GLSL 300 ES 双通道渲染；定义降序平滑插值的数学行为；雨量归零真正关雨；双色流体/图片/视频背景；凝结雾气与水痕清晰度；折射率映射；移除原场景的闪电、故事遮罩与色调脚本。

这是屏幕空间程序化高度场与折射近似，水珠重叠呈现合流视觉，不是逐滴质量守恒的物理流体求解。
