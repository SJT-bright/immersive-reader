#!/usr/bin/env python3
"""Generate the public, text-first project site and feature docs from verified facts.
Run: python3 scripts/build_public_site.py. No third-party packages are required.
"""
import json
from html import escape as e
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
F = json.loads((ROOT / 'docs/project-facts.json').read_text())
HOME, REPO = F['homepage'], F['repository']
DOWNLOAD = REPO + '/archive/refs/heads/main.zip'


def text(lang, zh, en):
    return zh if lang == 'zh' else en


def head(lang, page, title, desc):
    prefix = '' if lang == 'zh' else '../'
    rel = ('' if lang == 'zh' else 'en/') + ('' if page == 'index' else page + '.html')
    schema = {'@context': 'https://schema.org', '@graph': [
        {'@type': 'WebSite', '@id': HOME + '#site', 'url': HOME, 'name': '沉浸阅读器 · Immersive Reader by SJT-bright', 'inLanguage': ['zh-CN', 'en']},
        {'@type': 'SoftwareApplication', '@id': HOME + '#reader', 'name': 'Immersive Reader by SJT-bright', 'alternateName': '沉浸阅读器',
         'url': HOME, 'description': F['summary'][lang], 'softwareVersion': F['version'],
         'applicationCategory': 'EducationalApplication', 'operatingSystem': 'Browser; macOS desktop source',
         'softwareRequirements': 'Modern Chrome or Edge; Node.js or Python for local serving',
         'isAccessibleForFree': True, 'downloadUrl': DOWNLOAD, 'license': REPO + '/blob/main/LICENSE-NOTES.md',
         'creator': {'@type': 'Organization', 'name': 'SJT-bright', 'url': 'https://github.com/SJT-bright'},
         'featureList': [x[lang + 'Title'] for x in F['features']], 'screenshot': HOME + 'assets/reader.png'},
        {'@type': 'SoftwareSourceCode', '@id': REPO + '#source', 'name': 'SJT-bright/immersive-reader', 'codeRepository': REPO,
         'programmingLanguage': ['JavaScript', 'Python', 'CSS', 'HTML'], 'version': F['version'],
         'license': REPO + '/blob/main/LICENSE-NOTES.md', 'description': 'Original code: MIT. Third-party rain shader: CC BY-NC-SA 3.0; see license scope.'}
    ]}
    schema_json = json.dumps(schema, ensure_ascii=False).replace('</', '<' + chr(92) + '/')
    opposite = ('en/' if lang == 'zh' else '') + ('' if page == 'index' else page + '.html')
    alternate = HOME + opposite
    return f'''<!doctype html>
<html lang="{'zh-CN' if lang == 'zh' else 'en'}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)}</title><meta name="description" content="{e(desc)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="{HOME + rel}">
<link rel="alternate" hreflang="zh-CN" href="{HOME + ('' if page == 'index' else page + '.html')}">
<link rel="alternate" hreflang="en" href="{HOME + 'en/' + ('' if page == 'index' else page + '.html')}">
<link rel="alternate" hreflang="x-default" href="{HOME + ('' if page == 'index' else page + '.html')}">
<meta property="og:type" content="website"><meta property="og:site_name" content="沉浸阅读器 · Immersive Reader">
<meta property="og:title" content="{e(title)}"><meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{HOME + rel}"><meta property="og:image" content="{HOME}assets/reader.png">
<meta property="og:image:alt" content="{text(lang, '样例书在山谷双页场景中的实际截图', 'Actual screenshot of the sample book in the valley two-page scene')}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="{prefix}styles.css">
<script type="application/ld+json">{schema_json}</script>
</head><body>
<a class="skip" href="#main">{text(lang,'跳到正文','Skip to content')}</a>
<header class="header"><a class="brand" href="{prefix if prefix else './'}"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 8Q10 3 3 6v21q7-4 13 1 6-5 13-1V6Q22 3 16 8Zm0 0v20"/></svg><span>{text(lang,'沉浸阅读器','Immersive Reader')}<small>by SJT-bright</small></span></a>
<nav aria-label="{text(lang,'项目导航','Project navigation')}"><a href="{'' if lang=='zh' else '../en/'}features.html">{text(lang,'功能','Features')}</a><a href="{'' if lang=='zh' else '../en/'}faq.html">{text(lang,'常见问题','FAQ')}</a><a href="{REPO}">GitHub ↗</a><a lang="{'en' if lang=='zh' else 'zh-CN'}" href="{e(alternate)}">{text(lang,'English','简体中文')}</a></nav></header>
<main id="main">'''


def foot(lang):
    return f'''</main><footer><p>沉浸阅读器 · Immersive Reader by SJT-bright</p>
<p>{text(lang,'版本','Version')} {F['version']} · {text(lang,'更新','Updated')} {F['updated']} · <a href="{REPO}/blob/main/LICENSE-NOTES.md">{text(lang,'MIT 原创代码；第三方雨效保留原许可','MIT original code; third-party rain license retained')}</a></p>
<p>{text(lang,'本页是项目介绍；在自己的电脑下载运行，书籍和阅读资料保留在本机。','This is the project information site. Download and run locally; personal books and reading records stay on your computer.')}</p></footer></body></html>'''


def card(lang, f):
    return f'<article class="feature" id="{f["id"]}"><h2>{e(f[lang+"Title"])}</h2><p>{e(f[lang])}</p><a class="source" href="{REPO}/blob/main/{f["evidence"]}">{text(lang,"查看实现","Implementation")} ↗</a></article>'


for lang in ['zh', 'en']:
    out = SITE if lang == 'zh' else SITE / 'en'
    out.mkdir(parents=True, exist_ok=True)
    pre = '' if lang == 'zh' else '../'
    intro_title = text(lang, '沉浸阅读器 | 本地 EPUB/TXT 阅读器 · 雨窗、笔记与阅读记录', 'Immersive Reader by SJT-bright | Local EPUB & TXT Reader with Ambient Scenes')
    content = head(lang,'index',intro_title,F['summary'][lang])
    content += f'''<section class="hero"><div class="hero-copy"><p class="eyebrow">LOCAL BOOKS · QUIET SCENES</p>
<p class="edition">{text(lang,'本地电子书阅读工具','A local-first ebook reader')} · v{F['version']}</p>
<h1>{text(lang,'把时间，<br>留给阅读。','Make room<br>for reading.')}</h1>
<p class="lead">{e(F['summary'][lang])}</p><div class="actions"><a class="button primary" href="{DOWNLOAD}">{text(lang,'下载最新源码','Download source')}</a><a class="button" href="{REPO}">{text(lang,'查看 GitHub','View GitHub')}</a></div>
<p class="fine">{text(lang,'本机运行 · 无需读书器账号 · macOS 实测 · Windows / Linux 提供启动入口','Run locally · No reader account · Tested on macOS · Launchers for Windows / Linux')}</p></div>
<figure class="hero-image"><img src="{pre}assets/reader.png" width="1440" height="960" fetchpriority="high" alt="{text(lang,'山谷场景中的可选文字双页书，使用项目内置原创示例书','Selectable two-page text in a valley scene, using the built-in original sample book')}"><figcaption>{text(lang,'实际界面 · 原创示例书 · 非个人书库','Actual interface · Original sample book · No personal library')}</figcaption></figure></section>
<section class="identity"><h2>{text(lang,'读自己的书，建立自己的阅读积累','Your books, your reading record')}</h2><p>{text(lang,'项目将电子书阅读、可定制环境和本地阅读积累放在同一个界面。EPUB / TXT 进入可调排版的书页，划线可回到原文，阅读目标与热力图帮助回顾自己的习惯。','The project brings ebook reading, customizable atmosphere and local reading records into one interface. EPUB / TXT become adjustable pages; notes lead back to passages; daily goals and a heatmap show your habits.')}</p>
<div class="facts"><span><strong>EPUB / TXT / PDF</strong>{text(lang,'PDF 提取文字','PDF text extraction')}</span><span><strong>13</strong>{text(lang,'内置场景','built-in scenes')}</span><span><strong>6 + 10</strong>{text(lang,'原创音乐 + 环境声','original tracks + ambient modes')}</span><span><strong>16 {text(lang,'周','weeks')}</strong>{text(lang,'阅读记录宫格','daily reading grid')}</span></div></section>
<section class="feature-grid">{''.join(card(lang, f) for f in F['features'][:5])}</section>
<section class="media-row"><figure><img src="{pre}assets/music.png" width="1440" height="960" loading="lazy" alt="{text(lang,'样例书与音乐控制面板的实际界面','Actual sample-book interface with the music panel')}"><figcaption>{text(lang,'本地音乐与官方音乐链接入口','Local music and official music link controls')}</figcaption></figure><div><p class="eyebrow">ATMOSPHERE, AT YOUR PACE</p><h2>{text(lang,'窗外风景，<br>由你选择。','Choose your own<br>window view.')}</h2><p>{e(F['features'][5][lang])}</p><p>{e(F['features'][7][lang])}</p></div></section>
<section class="feature-grid">{''.join(card(lang, f) for f in F['features'][8:])}</section>
<section class="start"><h2>{text(lang,'下载后如何开始','Start reading locally')}</h2><ol><li>{text(lang,'下载完整源码 ZIP 并解压，保留所有文件。','Download and extract the complete source ZIP, keeping all files.')}</li><li>{text(lang,'Mac 运行 sh start.sh；Windows 双击 start.bat；Linux 使用 Python 启动。','On Mac run sh start.sh; on Windows use start.bat; on Linux use the Python launcher.')}</li><li>{text(lang,'浏览器打开 http://127.0.0.1:8940/，先读示例书，再导入自己的书籍。','Open http://127.0.0.1:8940/ in the browser. Try the sample before importing your books.')}</li></ol><p>{text(lang,'需要现代 Chrome / Edge 和 Node.js 或 Python，无需 npm 安装。','Requires modern Chrome / Edge and Node.js or Python; no npm installation.')} <a href="{REPO}/blob/main/{'README.md' if lang=='zh' else 'README.en.md'}">{text(lang,'完整运行说明','Full setup instructions')} ↗</a></p></section>
<section class="proof"><h2>{text(lang,'功能说明与验证记录','Capabilities and evidence')}</h2><p>{text(lang,'1.9.3 源码通过 303 项 Node 逻辑检查。目录悬停与页码交互有隔离浏览器及 macOS 实际窗口记录；Windows / Linux 尚未分别实机验收。截图来自隔离样例，不使用个人资料。','Version 1.9.3 passes 303 Node logic checks. Contents and page interactions have isolated-browser and macOS-window records; Windows / Linux have not had separate on-device acceptance. Screenshots use an isolated sample, not personal data.')}</p><p><a href="{REPO}/blob/main/VERIFICATION.md">{text(lang,'验证范围','Verification scope')}</a> · <a href="{REPO}/blob/main/LICENSE-NOTES.md">{text(lang,'许可范围','License scope')}</a> · <a href="features.html">{text(lang,'完整功能','All features')}</a> · <a href="faq.html">{text(lang,'格式、隐私与常见问题','Format, privacy and FAQ')}</a></p></section>'''
    (out/'index.html').write_text(content+foot(lang))
    feature_title = text(lang,'沉浸阅读器完整功能 | 双页、自动阅读、氛围音乐与阅读热力图','Immersive Reader features | Two-page reading, annotations, ambient audio and history')
    content = head(lang,'features',feature_title,F['summary'][lang])
    content += f'<section class="page-intro"><p class="eyebrow">CAPABILITIES · v{F["version"]}</p><h1>{text(lang,"从打开书，<br>到留下阅读积累。","From opening a book<br>to keeping your notes.")}</h1><p class="lead">{text(lang,"下列能力对应当前源码；每个条目都附实现入口。","These capabilities reflect the current source, with implementation links for each area.")}</p></section>'
    content += f'''<figure class="feature-shot"><img src="{pre}assets/toc.png" width="1440" height="960" loading="lazy" alt="{text(lang,'示例书的目录浮层与双页正文','Contents popover with the sample-book pages')}"><figcaption>{text(lang,'实际目录与双页界面 · 原创示例书','Actual contents and two-page interface · Original sample book')}</figcaption></figure>'''
    content += '<section class="feature-grid">'+''.join(card(lang,x) for x in F['features'])+'</section>'
    content += f'<section class="proof"><h2>{text(lang,"适用范围","Scope")}</h2><p>{text(lang,"可重排 EPUB 和文字型 PDF；扫描 PDF 需外部 OCR。官方音乐受平台授权影响。本地资料不自动跨设备云同步。完整雨窗版本包含非商业第三方许可，商用前需核对组件范围。","Reflowable EPUB and text-based PDF; scanned PDF requires external OCR. Official music is subject to platform rights. Local data does not automatically sync across devices. The full rain-glass version includes a non-commercial third-party license; review scope before commercial use.")}</p><a href="faq.html">{text(lang,"查看常见问题","Read the FAQ")}</a></section>'
    (out/'features.html').write_text(content+foot(lang))
    faq_title = text(lang,'沉浸阅读器常见问题 | 文件格式、离线使用、备份与开源许可','Immersive Reader FAQ | File formats, local use, backups and license scope')
    content = head(lang,'faq',faq_title,text(lang,'关于本地 EPUB/TXT/PDF 阅读、音乐、阅读进度、数据保存和开源许可的具体说明。','Answers about local EPUB/TXT/PDF reading, audio, progress, data storage and source licensing.'))
    content += f'<section class="page-intro"><p class="eyebrow">QUESTIONS, WITH CONTEXT</p><h1>{text(lang,"开始前，<br>把问题说清楚。","Clear answers<br>before you start.")}</h1></section><div class="faq">'
    for i,x in enumerate(F['faq']):
        content += f'<section id="q{i+1}"><h2>{e(x[lang+"Q"])}</h2><p>{e(x[lang+"A"])}</p></section>'
    (out/'faq.html').write_text(content+'</div>'+foot(lang))

urls=[HOME+p for p in ['', 'features.html','faq.html','en/','en/features.html','en/faq.html']]
xml='''<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'''
for u in urls: xml+=f'  <url><loc>{e(u)}</loc><lastmod>{F["updated"]}</lastmod></url>\n'
(SITE/'sitemap.xml').write_text(xml+'</urlset>\n')
(SITE/'.nojekyll').write_text('')
(SITE/'project.json').write_text(json.dumps(F,ensure_ascii=False,indent=2)+'\n')
(SITE/'llms.txt').write_text(f'''# Immersive Reader by SJT-bright / 沉浸阅读器

> {F['summary']['en']}

Version: {F['version']}. Updated: {F['updated']}.
This file is a navigation aid, not a ranking directive.

## Project documentation
- [Chinese overview]({HOME})
- [English overview]({HOME}en/)
- [Features]({HOME}en/features.html)
- [FAQ]({HOME}en/faq.html)
- [Source repository]({REPO})
- [License scope]({REPO}/blob/main/LICENSE-NOTES.md): MIT original code; the Heartfelt-derived rain shader remains CC BY-NC-SA 3.0.
- [Verification]({REPO}/blob/main/VERIFICATION.md)
- [Machine-readable facts]({HOME}project.json)

## Scope
Reflowable EPUB, TXT, PDF text extraction; no scanned-PDF OCR, DRM bypass, hosted book account or automatic cross-device cloud sync. The site is a project overview; personal reading runs locally. This project is independent of Microsoft Immersive Reader.
''')
for lang in ['zh','en']:
    doc='# '+text(lang,'沉浸阅读器完整功能','Immersive Reader — full features')+'\n\n'+F['summary'][lang]+f'\n\nVersion {F["version"]} · {F["updated"]}\n'
    for x in F['features']:
        doc+='\n## '+x[lang+'Title']+'\n\n'+x[lang]+f'\n\n[Source]({REPO}/blob/main/{x["evidence"]})\n'
    (ROOT/'docs'/('FEATURES.md' if lang=='zh' else 'FEATURES.en.md')).write_text(doc)
    doc='# '+text(lang,'沉浸阅读器常见问题','Immersive Reader FAQ')+f'\n\nVersion {F["version"]} · {F["updated"]}\n'
    for x in F['faq']:doc+='\n## '+x[lang+'Q']+'\n\n'+x[lang+'A']+'\n'
    (ROOT/'docs'/('FAQ.md' if lang=='zh' else 'FAQ.en.md')).write_text(doc)
print('Generated 6 HTML pages, sitemap, project facts, navigation index and 4 feature/FAQ documents.')
