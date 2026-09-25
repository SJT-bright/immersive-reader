# 沉浸阅读器

导入自己的 EPUB、TXT 或文字型 PDF，在雨窗、雪景和动态风景中阅读。支持自动阅读、划线笔记、书签、阅读进度、本地音乐和官方音乐外链。无需账号，无需 npm 安装或构建。

## 下载与本地运行

在 GitHub 点击 **Code → Download ZIP**，解压整个文件夹；当前最新源码以 main 分支为准；旧版安装或发布附件见 [Releases](https://github.com/SJT-bright/immersive-reader/releases)。

需要 **Node.js 16+（推荐 22.5+）或 Python 3.9+**，以及现代 Chrome / Edge 浏览器。无需安装 npm 依赖。macOS/Linux 的 start.sh 优先使用 Node，未安装时回退 Python；Windows 的 start.bat 使用 Python。也可跨平台运行 `node cloud/server.js --port 8940 --no-open`。

- **macOS**：在解压目录打开终端运行 `sh start.sh`，或双击 `start.command`。
- **Windows**：双击 `start.bat`；也可在目录终端运行 `py -3 scripts/serve.py --port 8940`。
- **Linux**：在目录终端运行 `python3 scripts/serve.py --port 8940`。

然后在浏览器打开 **http://127.0.0.1:8940/**，点击示例书体验，或导入自己的书。不要直接双击 index.html。终端保持打开，Ctrl+C 停止服务。服务只监听本机环回地址。

请一直使用相同浏览器及地址；`localhost` 与 `127.0.0.1`、不同端口的浏览器存储互相独立。Node 服务遇到同一项目服务时复用；被其他程序占用时可能顺延端口，请以终端显示的地址为准。Python 启动器保持指定端口。

## 近期更新（2026-09-25）

双页书本提供参数化纸面光照与柔和中缝；底部音乐条、速度设置和主面板在桌面、窄屏与横屏布局中避让。新增阅读中目录、书页比例设置，以及自动阅读档位：定时翻页的慢／适中／快分别为 70／50／30 秒。自动阅读启停会联动阅读计时。

本地运行不需要 npm 安装。项目工作目录可直接用 Git 拉取更新；个人书籍、笔记与播放列表的数据文件不在仓库中。`node --test tests/*.test.mjs` 可运行逻辑测试。

## 最新功能（2026-09-22）

- 按钮悬停抬起、按压回落，面板虚化渐入/渐出，兼容减少动态偏好。
- 浅色立体双页书、柔和中缝、可保存的紧凑排版和单页宽度设置。
- 参数化纸面光照：弧面受光、中缝遮蔽、接触阴影与柔和投影；详见 [光照参数与函数](docs/BOOK_LIGHTING.md)。这是保留真实可选文字的 2.5D 近似。
- 内置原创《林间慢读》MP3，支持保存、拖入本地音频及播放列表排序。
- Node 统一服务支持本机/便携/云端形态；源码直接运行无需安装依赖。


- TXT 自动识别 UTF-8、带 BOM 的 UTF-16、GB18030、Big5；识别书名作者、自动分章并转换为阅读排版。无 BOM 的 UTF-16BE 仍可能误判，建议先另存为 UTF-8。
- EPUB 与文字型 PDF 导入，目录、翻页、滚动阅读；扫描 PDF 不提供 OCR。
- 自动阅读位于主阅读工具栏，支持滚动与定时翻页；听书功能已移除。
- 划线、心得、书签、阅读进度和备份导入导出。
- 雨窗、雪景、动态场景、图片和静音视频背景；本地音频、网易云和 QQ 官方外链。官方音乐是否能播放由平台与歌曲授权决定。
- 磁盘镜像不可用时先保存到浏览器并提示；恢复服务后重启应用补同步。

## 数据保存

首次运行是空书库，仓库不含任何个人书籍、笔记或账号数据。内容存于本机浏览器 IndexedDB，并通过本地服务镜像至 SQLite。当前默认磁盘位置（所有系统使用同一相对主目录路径）：

`~/Library/Application Support/immersive-reader-app/library/library.sqlite3`

其中 `~` 是当前用户主目录；可在启动前用环境变量 `READER_DATA_DIR` 指定其他目录。定期在书库内导出备份。请勿把数据库提交到 GitHub。

## 与个人积累库联动

阅读器可独立使用，不依赖个人积累库。本仓库不包含个人积累库软件。配套程序可读取 `GET /_reader/health`、`GET /_reader/library`，以 `?book=<ID>&note=<ID>` 打开原文；本仓库本身不提供跨设备云同步。

## 开发与验证

前端为原生 ES modules；Node 服务零 npm 依赖，Python 备用服务仅使用标准库。阅读引擎和字体依赖已经随源码保留，无需在线下载。

使用 Node.js 运行逻辑测试：

```sh
node --test tests/*.test.mjs
```

本次发布在 macOS 上验证源码副本启动、HTTP 接口和逻辑测试。Windows/Linux 提供跨平台 Python 启动入口，尚未在对应系统实机验收。

## 许可与署名

各组件保留原许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 licenses/。雨滴着色器衍生自 BigWings 的 Heartfelt，采用 CC BY-NC-SA 3.0，完整项目不能当作纯 MIT 商用代码。请保留来源、许可与署名。

`desktop/` 保留 macOS Electron 包装层源码（主进程入口与包信息），日常本地运行使用上述 Node/Python 启动方式，无需 Electron。此源码快照不附带个人积累库 APP 或已签名安装器。

更新历史见 [CHANGELOG.md](CHANGELOG.md)，验证范围见 [VERIFICATION.md](VERIFICATION.md)。
