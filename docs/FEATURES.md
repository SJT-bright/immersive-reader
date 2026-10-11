# 沉浸阅读器完整功能

沉浸阅读器是 SJT-bright 开发的本地电子书阅读工具，支持 EPUB、TXT 和文字型 PDF，结合立体双页、雨窗与雪景、氛围音乐、划线笔记和阅读记录。无需账号，个人书籍与记录保存在本机。

Version 1.9.5 · 2026-10-11

## EPUB / TXT / PDF 文字导入

拖入或选择可重排 EPUB、TXT、文字型 PDF。TXT 识别 UTF-8、UTF-16、GB18030 / GBK、Big5，结合文件名提取书名作者并自动分章；PDF 按页面坐标重组文字。长文件转换提供进度与取消入口。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/library.js)

## 3D 书架与紧凑列表

保留原书封面，无封面时生成书名封面；按书名或作者搜索，按最近打开、导入时间、书名、进度排序。可从书架查看目录和各章进度，继续上次阅读，或删除书籍。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/bookshelf.js)

## 立体双页与可选中文字

书桌与风景中的浅色双页带柔和书缝、参数化纸面受光和翻页动效；正文仍是可以选中、搜索、划线的真实文字。支持左右翻页、连续滚动、宋体 / 黑体 / 楷体、字号、行距、页宽和排版密度调整。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/reader.js)

## 目录、页码、全书搜索与进度

目录可过滤章节，展开页码并直接跳章或跳页，显示每章已读比例；鼠标悬停可展开，触屏和键盘也可操作。支持中英文全书搜索、返回跳转前位置、关闭重开恢复进度；进度归零保留笔记和书签。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/main.js)

## 自动滚动与定时翻页

提供慢 / 适中 / 快预设，以及滚动速度、每页停留、章末停留的细调。自动阅读联动计时；手动翻页时重置等待时间后继续，离开页面或切书时暂停。全屏、隐藏工具和快捷键帮助专注阅读。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/auto-reading.js)

## 13 种场景与自定义图片 / 视频

内置群山黎明、极光夜空、双色流体、花园、草原、森林、湖畔、雨庭、雪原，以及书桌、山谷、咖啡厅、山崖四种立体书环境。可上传、命名和删除自己的图片或静音视频；固定一张、按早晚时段或按分钟轮换，并设置切换渐变。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/background.js)

## 雨窗、落雪与文字可读性保护

雨 / 雪 / 晴天可切换，支持强度和动态开关；高级设置可调雾气、微风、折射、景深、远处闪电等。提供专注阅读、轻氛围、完整场景预设。依据正文区域的背景明暗调整文字与保护底色，并尊重系统减少动态效果设置。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/readability.js)

## 原创音乐、环境声与官方音乐链接

内置六首原创程序合成氛围音乐；可导入本地 MP3 / WAV / OGG / M4A 等，排序播放列表、拖动进度、调音量，选择列表循环、单曲循环、顺序或随机播放，设置淡入淡出及睡眠定时。另有雨声、落雪、海浪、山风、溪流、篝火、虫鸣、白 / 粉 / 棕噪十种环境声；网易云与 QQ 音乐通过官方外链或官方打开入口使用。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/music-ui.js)

## 划线、心得、书签与 Markdown 导出

选中文字即可划线或写想法，笔记按书保存，可编辑心得、回到对应原文，收藏当前位置为书签。划线与书签分区展示，删除支持撤销；单本书的划线、心得和书签可导出为 Markdown。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/notes.js)

## 每日目标、16 周热力图与阅读成就

记录今日与累计阅读时长、连续天数、最近阅读和按累计时长解锁的成就。16 周日期宫格支持鼠标、键盘和触屏查看完整日期与分钟数；每日目标显示剩余时间或达标状态。页面转入后台时暂停计时，历史可清空。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/reading-log-ui.js)

## 本地保存、备份恢复与积累库联动

浏览器 IndexedDB 与本机 SQLite 镜像保存资料；完整备份包含书籍、背景、音乐、笔记、位置与设置。恢复时可合并或覆盖，并先下载恢复前快照。可独立运行，也可通过本机接口及书籍 / 笔记链接与配套个人积累库联动。

[Source](https://github.com/SJT-bright/immersive-reader/blob/main/js/backup.js)
