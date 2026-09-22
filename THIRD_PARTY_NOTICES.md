# 第三方组件与素材

## foliate-js

来源：https://github.com/johnfactotum/foliate-js

固定 commit：`78914aef4466eb960965702401634c2cb348e9b1`。引擎位于 `vendor/foliate-js/`，没有修改上游已跟踪文件。许可为 MIT，完整版权和许可文本保留在 `vendor/foliate-js/LICENSE`。本项目只开放 EPUB/TXT 阅读入口；上游 API 以此固定版本使用。

开发工作区可用 `git -C vendor/foliate-js rev-parse HEAD` 核对。分发包不带 `.git` 与工具工作记录，使用 `licenses/foliate-js-sha256.json` 记录固定版本所有上游文件的 SHA-256；`scripts/package.py` 打包时核对源码未被改动。

## 上游附带依赖

以下依赖由 foliate-js 原样携带。版本范围来自固定版本的 `vendor/foliate-js/package.json`，不将依赖范围视作打包文件的精确版本证据。分发时保留原文件，并补齐独立许可全文：

- **zip.js**：https://github.com/gildas-lormeau/zip.js ，BSD-3-Clause。应用文件 `vendor/foliate-js/vendor/zip.js`。完整许可在 `licenses/zip.js-LICENSE.txt`，取自官方 v2.7.52 标签。
- **fflate**：https://github.com/101arrowz/fflate ，MIT。应用文件 `vendor/foliate-js/vendor/fflate.js`。完整许可在 `licenses/fflate-LICENSE.txt`，取自官方 v0.8.2 标签。
- **PDF.js**：https://github.com/mozilla/pdf.js ，Apache-2.0。文件在 `vendor/foliate-js/vendor/pdfjs/`，由上游携带，本阅读页使用其本地文字提取接口提供 PDF 文字导入。完整许可在 `licenses/pdfjs-LICENSE.txt`，取自官方 v5.5.207 标签。字体与 CMap 的独立许可保留在该目录的 `standard_fonts/LICENSE_FOXIT`、`standard_fonts/LICENSE_LIBERATION`、`cmaps/LICENSE`。

许可全文于 2026-09-08 从上述官方仓库的对应标签取得；文件内容校验列入分发包校验清单。

## 本项目素材

`assets/backgrounds/` 的 6 幅风景 SVG 与 1 幅流体渐变 SVG 是为本项目程序绘制的示意插画，非照片，不取自第三方图库。`js/icons.js` 的 SVG 图标集是自绘几何图形，没有引用第三方图标库。`js/sample-book.js` 与 `tests/fixtures/` 的书籍、测试图片、音频和生成的视频色卡是本项目提供的演示与验收素材，可随本项目源码使用和修改。它们不包含用户个人资料。

## 网易云播放器

播放器来自 `https://music.163.com/outchain/player?...` 官方 iframe。本项目只解析用户输入链接并生成官方嵌入地址，不分发、不代理网易云的播放器代码或音频。网易云品牌及歌曲权益归各自权利人；是否能播放由对应资源与服务决定。

## 运行环境

浏览器运行原生 ES modules，无 npm 依赖安装或构建步骤。Python 3 仅用于提供本机静态文件服务。Node.js 仅供开发者运行逻辑回归，不是使用阅读器的依赖。

`tests/ui-check.mjs` 是可选的界面验收脚本，需要开发者自备 `playwright-core`（通过 `PLAYWRIGHT_CORE` 指向其路径）。它只用于测试，不随分发包携带、也不被应用运行时引用；不安装它不影响阅读器任何功能。

## Heartfelt / Amado 雨滴核心

`js/rain-shaders.js` 的驻留水滴、滑落水滴及叠层高度场衍生自 Martijn Steinrucken（BigWings），2017，Shadertoy《Heartfelt》：https://www.shadertoy.com/view/ltffzl 。本轮从只读 Amado commit `978333a5e5f29b5c1753839240a19f445a71777a` 取得对应 GLSL 实现，未携带 Amado 的视频、图片或音频。

雨滴衍生文件按 CC BY-NC-SA 3.0 分发，保留署名、非商业与相同方式共享要求。原始页面本轮访问受阻，许可依据为公开移植的逐文件署名与许可标注；不能以 Amado 总体 MIT 声明覆盖底层作品许可。详细来源、许可 URI 与改动记录在 `licenses/Heartfelt-NOTICE.md`，Amado MIT 版权原文在 `licenses/Amado-MIT.txt`。

新双色流体背景、双通道集成、雨窗控制台为本项目实现。项目没有新增运行时网络依赖，shader 随源码本地加载。完整雨窗版本不应被宣传为全部采用 MIT。

## QQ 音乐官方外链播放器（2026-09-09）

仅嵌入 https://i.y.qq.com/n2/m/outchain/player/index.html ，未复制、分发其播放器源码或歌曲。读取官方部署脚本 https://y.qq.com/m/outchain/player/index.2ee216446.js 核实 `songid` 与 `shorttag` 参数；普通 songmid、歌单与专辑链接提供官方跳转。播放与曲目授权由 QQ 音乐决定。

## 原创内置轻音乐（2026-09-22）
`assets/audio/forest-reading.mp3` 为本项目程序合成的原创轻音乐，无外部录音或采样；可随本项目分发。生成源码：`scripts/generate_builtin_music.py`，48 秒立体声 MP3。

`assets/backgrounds/fp-valley-real.png`：2026-09-22 使用 imagegen 生成的山谷晨光背景；近景书籍和真实正文由 CSS 透视实时绘制。其余第一人称环境为项目原有 SVG 绘制场景。
