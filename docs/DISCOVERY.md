# 项目搜索发现与 GEO 记录

2026-10-10 · 当前源码 1.9.4 · 维护者 SJT-bright

## 当前定位

完整实体名：**沉浸阅读器 · Immersive Reader by SJT-bright**。唯一源码地址为 https://github.com/SJT-bright/immersive-reader ，公开项目页面为 https://sjt-bright.github.io/immersive-reader/ 。定位是本地电子书阅读、可定制氛围与可导出的阅读积累。

GitHub 实时搜索 `immersive-reader` 出现微软 SDK 等多个同名项目；因此英文介绍始终带维护者和 local-first ebook reader 的类别。不要把该项目与 Microsoft / Azure 的产品混为一谈，也不要把项目介绍网站当成在线托管书库。

## 搜索意图与内容对应

| 用户可能搜索或向 AI 提问的需求 | 对应公开内容与证据 |
| --- | --- |
| 本地 EPUB 阅读器 / local EPUB reader | README 的格式、启动和数据说明；features 的 formats / data |
| TXT 小说阅读器，自动分章与编码识别 | formats；FAQ 的支持格式；js/txt-detect.js 和 js/txt2epub.js |
| PDF 提取文字后重新排版阅读 | formats；FAQ 明确文字层和扫描件的区别 |
| 雨窗阅读器 / ambient ebook reader | scenes、weather；实际界面样例图；背景和雨窗实现 |
| 双页电子书阅读器，可选文字 | reading；FAQ 的 DOM 文字与 2.5D 说明 |
| 自动滚动、定时翻页 | automatic；FAQ 的手动翻页与暂停语义 |
| 电子书划线笔记导出 Markdown | notes；FAQ 的备份与单书笔记导出 |
| 阅读目标、阅读热力图 | history；每日日期与分钟提示的实现 |
| 白噪音与电子书阅读 | audio；10 种环境声和 6 首生成音乐的来源 |
| Mac 本地阅读器，无账号 | README 启动表与实际验收范围 |
| 私人书籍留在本机、无账号阅读 | data；FAQ 区分本地资料、外部音乐请求与云同步 |
| 开源电子书阅读器的许可 | LICENSE、LICENSE-NOTES；不把非商业雨效误写为纯 MIT |

这些是与功能吻合的查询主题，不是经工具验证的搜索量或排名预测。自然解释功能，不在页面里机械重复关键词。

## 本轮实现

- 中英文 README、11 个功能域、14 个明确 FAQ，全部说明真实支持范围。
- 6 个不依赖前端 JavaScript 的公开 HTML 页面；主页、完整功能、FAQ 各有中文与英文。
- 每页有独立标题、描述、canonical、互相对应的 hreflang、Open Graph 图片与可见文本。
- SoftwareApplication / SoftwareSourceCode 结构化资料反映真实版本、作者、下载和许可范围；不编造评分、销量、奖项、用户数或外部推荐。
- sitemap.xml、project.json 与可选 llms.txt 导航索引。llms.txt 仅帮助内容定位，没有排名保证。
- 截图来自隔离样例书，不公开个人资料。源码生成器保证 README 以外的功能/FAQ/HTML 使用同一 facts 清单。
- GitHub About、Topics 和主页链接；1.9.4 源码发布；公开逻辑检查与 Pages 部署流程。

GitHub 项目 Pages 位于域名子路径。实际爬虫政策由 **https://sjt-bright.github.io/robots.txt** 决定，不能把项目子路径里的 robots.txt 当作根政策。发布时核对根路径与页面 noindex 状态；未控制其他项目或账号配置。

## 官方依据与推断边界

- [Google AI features](https://developers.google.com/search/docs/appearance/ai-features)：AI Search 延续一般搜索的抓取、可读内容、内部链接等要求；没有特别的 AI 文件或专用 Schema 要求，也不保证收录。我们据此采用直接可读的 HTML。
- [Bing AI Performance](https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/)：提供被 AI 引用的页面与查询信息，并建议清楚结构、证据和及时更新。我们据此整理功能域与 FAQ；这不等于已获得引用。
- [OpenAI crawlers](https://developers.openai.com/api/docs/bots)：OAI-SearchBot 用于搜索，与训练爬虫分别控制。页面可抓取不保证 ChatGPT 一定采用。
- [GitHub Topics](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics)：准确主题帮助发现相关仓库；不声明添加主题就能排第一。
- [Google sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)：网站地图提供页面信息，仍由搜索引擎决定是否抓取和收录。

## 复核与持续更新

每次版本更新同步 docs/project-facts.json、README 和 CHANGELOG，再生成和检查页面。公开标签必须继续对应真实能力；OCR、TTS、云同步、Windows 实机支持或完整 MIT 商用版本只有实际完成后才能加入。

后续人工复核可使用固定查询“本地 EPUB 阅读器 雨窗”“TXT 自动分章 阅读笔记”“local EPUB reader ambient scenes”，记录搜索引擎、日期、是否发现仓库、是否正确引用功能及来源链接。没有看到项目时记录“本次检索未出现”，不从一次查询推断全网未收录。基于站长工具的展示、点击和 AI 引用变化评估效果；本轮不建立自动监控，也不登录站长账号。

搜索排名、首次索引时间及不同用户/地区的结果由平台控制，本轮可验证的是公开资料、线上可达性与技术配置。
