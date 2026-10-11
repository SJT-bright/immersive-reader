# 沉浸阅读器 · Immersive Reader by SJT-bright

**本地 EPUB / TXT / PDF 文字阅读器，结合立体双页、雨窗与雪景、氛围音乐、划线笔记和阅读热力图。**

[English](README.en.md) · [项目主页](https://sjt-bright.github.io/immersive-reader/) · [完整功能](docs/FEATURES.md) · [常见问题](docs/FAQ.md) · [最新源码 ZIP](https://github.com/SJT-bright/immersive-reader/archive/refs/heads/main.zip) · [版本发布](https://github.com/SJT-bright/immersive-reader/releases)

沉浸阅读器是 SJT-bright 开发的本地电子书阅读工具，支持 EPUB、TXT 和文字型 PDF，结合立体双页、雨窗与雪景、氛围音乐、划线笔记和阅读记录。无需账号，个人书籍与记录保存在本机。 原创代码按 MIT 开源；完整雨窗版本还包含 CC BY-NC-SA 第三方效果，见[许可范围](LICENSE-NOTES.md)。

**当前源码：1.9.6 · 更新：2026-10-11。** 项目标识是 `SJT-bright/immersive-reader`，便于区分同名产品。macOS 与 Windows 使用同一仓库。

![沉浸阅读器实际界面：山谷场景与真实可选中的双页文字，使用原创示例书](site/assets/reader.png)

## 功能与亮点

| 能力 | 当前版本提供的功能 |
| --- | --- |
| EPUB / TXT / PDF 文字导入 | 拖入或选择可重排 EPUB、TXT、文字型 PDF。TXT 识别 UTF-8、UTF-16、GB18030 / GBK、Big5，结合文件名提取书名作者并自动分章；PDF 按页面坐标重组文字。长文件转换提供进度与取消入口。 |
| 3D 书架与紧凑列表 | 保留原书封面，无封面时生成书名封面；按书名或作者搜索，按最近打开、导入时间、书名、进度排序。可从书架查看目录和各章进度，继续上次阅读，或删除书籍。 |
| 立体双页与可选中文字 | 书桌与风景中的浅色双页带柔和书缝、参数化纸面受光和翻页动效；正文仍是可以选中、搜索、划线的真实文字。支持左右翻页、连续滚动、宋体 / 黑体 / 楷体、字号、行距、页宽和排版密度调整。 |
| 目录、页码、全书搜索与进度 | 目录可过滤章节，展开页码并直接跳章或跳页，显示每章已读比例；鼠标悬停可展开，触屏和键盘也可操作。支持中英文全书搜索、返回跳转前位置、关闭重开恢复进度；进度归零保留笔记和书签。 |
| 自动滚动与定时翻页 | 提供慢 / 适中 / 快预设，以及滚动速度、每页停留、章末停留的细调。自动阅读联动计时；手动翻页时重置等待时间后继续，离开页面或切书时暂停。全屏、隐藏工具和快捷键帮助专注阅读。 |
| 13 种场景与自定义图片 / 视频 | 内置群山黎明、极光夜空、双色流体、花园、草原、森林、湖畔、雨庭、雪原，以及书桌、山谷、咖啡厅、山崖四种立体书环境。可上传、命名和删除自己的图片或静音视频；固定一张、按早晚时段或按分钟轮换，并设置切换渐变。 |
| 雨窗、落雪与文字可读性保护 | 雨 / 雪 / 晴天可切换，支持强度和动态开关；高级设置可调雾气、微风、折射、景深、远处闪电等。提供专注阅读、轻氛围、完整场景预设。依据正文区域的背景明暗调整文字与保护底色，并尊重系统减少动态效果设置。 |
| 原创音乐、环境声与官方音乐链接 | 内置六首原创程序合成氛围音乐；可导入本地 MP3 / WAV / OGG / M4A 等，排序播放列表、拖动进度、调音量，选择列表循环、单曲循环、顺序或随机播放，设置淡入淡出及睡眠定时。另有雨声、落雪、海浪、山风、溪流、篝火、虫鸣、白 / 粉 / 棕噪十种环境声；网易云与 QQ 音乐通过官方外链或官方打开入口使用。 |
| 划线、心得、书签与 Markdown 导出 | 选中文字即可划线或写想法，笔记按书保存，可编辑心得、回到对应原文，收藏当前位置为书签。划线与书签分区展示，删除支持撤销；单本书的划线、心得和书签可导出为 Markdown。 |
| 每日目标、16 周热力图与阅读成就 | 记录今日与累计阅读时长、连续天数、最近阅读和按累计时长解锁的成就。16 周日期宫格支持鼠标、键盘和触屏查看完整日期与分钟数；每日目标显示剩余时间或达标状态。页面转入后台时暂停计时，历史可清空。 |
| 本地保存、备份恢复与积累库联动 | 浏览器 IndexedDB 与本机 SQLite 镜像保存资料；完整备份包含书籍、背景、音乐、笔记、位置与设置。恢复时可合并或覆盖，并先下载恢复前快照。可独立运行，也可通过本机接口及书籍 / 笔记链接与配套个人积累库联动。 |

双页的视觉效果基于真实 DOM 文字和 2.5D 纸面光照；文字仍可选中、搜索、划线。环境既可以使用预设，也可以逐项调节。书籍、原文锚点和阅读记录共同形成可导出的本地阅读积累。

## 支持的书籍格式

| 格式 | 处理方式与边界 |
| --- | --- |
| EPUB | 可重排电子书；沿用目录与正文，固定版式 / DRM 加密书不属于承诺支持的范围 |
| TXT | 自动编码检测、书名作者识别、分章并转换为阅读排版；不确定时显示容错检测结果 |
| PDF | 提取文字层、按页面坐标重组文字；不保留原图片和固定版式，扫描 PDF 需外部 OCR |

## 下载与本地运行

下载完整源码 ZIP 并解压。使用现代 Chrome / Edge 和 **Node.js 16+（推荐 22.5+）或 Python 3.9+**。浏览器版无需 npm 安装或构建。

| 系统 | 启动方式 |
| --- | --- |
| macOS | 在项目目录运行 `sh start.sh`，或双击 `start.command` |
| Windows | 双击 `start.bat`。它优先用 Node.js 16+ 启动 `cloud/server.js`，没有 Node 时再试 `py -3` 和 `python` |
| Linux | `python3 scripts/serve.py --port 8940`，或在有 Node 时运行 `sh start.sh` |

也可运行 `node cloud/server.js --port 8940 --no-open`。打开 **http://127.0.0.1:8940/**，先体验内置原创示例书，再拖入自己的电子书。保持终端服务运行，Ctrl+C 停止；不要直接打开 index.html。

源码服务默认只监听本机环回地址。尽量保持相同浏览器与地址：`localhost`、`127.0.0.1` 和不同端口的浏览器缓存互相独立。Node 服务复用本项目服务，端口被其他程序占用时以启动器提示为准；Python 保持指定端口。

macOS 已有实际浏览器与桌面验收。Windows 的启动脚本、书库目录、界面字体和桌面壳菜单已按系统分开；这次没有在 Windows 电脑上实机验收。Linux 同样提供启动入口。`desktop/` 是 macOS / Windows 共用的 Electron 壳源码；已发布的安装包仍是 macOS 应用，源码 ZIP 本身不附带已签名或已公证安装器。

## 数据与隐私

首次运行仅包含原创示例书。仓库和项目主页不包含个人书籍、笔记、数据库或账号资料。书籍在浏览器本地解析，内容存于 IndexedDB；使用本机服务时同时镜像至 SQLite，默认目录为：

| 系统 | 默认 SQLite |
| --- | --- |
| macOS | `~/Library/Application Support/immersive-reader-app/library/library.sqlite3` |
| Windows | `%APPDATA%\immersive-reader-app\library\library.sqlite3` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/immersive-reader-app/library/library.sqlite3` |

可用 `READER_DATA_DIR` 改资料目录。请通过书架的备份入口定期导出完整资料；迁移浏览器或电脑前先备份。恢复可合并或覆盖，操作前下载恢复前快照。笔记还可按书导出 Markdown。

阅读器没有账号式跨设备云同步。网易云 / QQ 官方播放器与外部链接会访问相应第三方服务；本地阅读、内置音乐和程序环境声无需外部读书服务。官方音乐能否播放由平台与歌曲授权决定。

## 与个人积累库联动

可独立使用。配套工具可读取 `GET /_reader/health`、`GET /_reader/library`，以 `?book=<ID>&note=<ID>` 定位书籍或原文笔记。本仓库不包含配套个人积累库程序。

## 最新版本 1.9.6

- Windows 书库改到 `%APPDATA%\immersive-reader-app\library`，Linux 改到 XDG 数据目录。macOS 仍使用 `~/Library/Application Support/immersive-reader-app/library`。
- `start.bat` 与 macOS 一样优先启动 Node 服务，没有 Node 时再使用 Python。桌面壳在 Windows 上使用同一书库目录和 Windows 菜单。
- 界面字体补上 Windows 常见的宋体、微软雅黑和 Segoe UI。系统音量滑块仍只在 macOS 可用，Windows 使用系统音量键。
- 路径规则有 Node、桌面壳与 Python 的对照检查。没有在 Windows 电脑上实机验收。1.9.5 的目录修复仍在 [CHANGELOG.md](CHANGELOG.md)。

详情见 [CHANGELOG.md](CHANGELOG.md)，验证范围见 [VERIFICATION.md](VERIFICATION.md)。

## 开发与贡献

```sh
node --test tests/*.test.mjs
python3 scripts/build_public_site.py
python3 scripts/check_public_site.py
```

当前 358 项 Node 逻辑测试通过。页面介绍源于 `docs/project-facts.json`，中英文功能 / FAQ 与公开 HTML 从同一清单生成；新增能力时一起更新。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

原创代码采用 [MIT](LICENSE)。foliate-js、PDF.js、字体及其他第三方文件保持各自许可；`js/rain-shaders.js` 含 Heartfelt 衍生雨效，采用 **CC BY-NC-SA 3.0**。因此完整雨窗版本不是纯 MIT、无商用限制的整包。完整清单见 [LICENSE-NOTES.md](LICENSE-NOTES.md) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
