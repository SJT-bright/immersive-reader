"""Isolated real-Chromium TOC regression and timing checks.

Run against scripts/serve.py --port 19211 --no-open:
    python3 tests/toc-refactor-check.py
No formal-library API, browser profile, installed reader or user book is used.
Timing starts inside DOM event capture; Playwright waits/sleeps are excluded.
"""
import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / '.preview/toc-refactor-20261011'
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
POP = '#reading-toc-popover'
LIST = '#reading-toc-list'
GO = '[data-action="toc-go"]'
CHECKS, ERRORS = [], []
ENVIRONMENT = {}


def record(name, ok, detail=None):
    CHECKS.append({'name': name, 'ok': bool(ok), 'detail': detail})
    print(('PASS' if ok else 'FAIL'), name, json.dumps(detail, ensure_ascii=False) if detail is not None else '', flush=True)


def fixture(out):
    path = out / '774目录.epub'
    if path.exists():
        return path
    with ZipFile(path, 'w', ZIP_DEFLATED) as z:
        z.writestr('mimetype', 'application/epub+zip')
        z.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
        manifest, spine, nav = [], [], []
        for n in range(86):
            children, body = [], []
            for k in range(9):
                label = f'章节{n+1:02d} 小节{k+1} 目录响应检查'
                children.append(f'<li><a href="ch{n}.xhtml#p{k}">{label}</a></li>')
                body.append(f'<h2 id="p{k}">{label}</h2>' + '<p>' + '这是原创目录压力测试文字，用于检查定位和点击响应，不包含用户书籍内容。' * 48 + '</p>')
            nav.append(f'<li><a href="ch{n}.xhtml#p0">章节{n+1:02d} 小节1 目录响应检查</a><ol>' + ''.join(children[1:]) + '</ol></li>')
            z.writestr(f'OPS/ch{n}.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>目录测试</title></head><body>' + ''.join(body) + '</body></html>')
            manifest.append(f'<item id="ch{n}" href="ch{n}.xhtml" media-type="application/xhtml+xml"/>')
            spine.append(f'<itemref idref="ch{n}"/>')
        z.writestr('OPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>' + ''.join(nav) + '</ol></nav></body></html>')
        z.writestr('OPS/book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">toc-774-original-fixture</dc:identifier><dc:title>774目录原创压力测试</dc:title><dc:language>zh</dc:language><dc:creator>测试夹具</dc:creator><meta property="dcterms:modified">2026-10-11T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' + ''.join(manifest) + '</manifest><spine>' + ''.join(spine) + '</spine></package>')
    return path


def setup(browser, url, **options):
    context = browser.new_context(service_workers='block', timezone_id='Asia/Taipei', **options)
    context.route('**/_reader/library', lambda route: route.abort())
    context.add_init_script("""localStorage.setItem('immersive-reader-settings-v1',JSON.stringify({
        background:{mode:'fixed',fixedId:'builtin:fluid'},atmosphere:{enabled:false},
        misc:{keepToolbarWhenIdle:true,readingPreset:'custom'}}));""")
    page = context.new_page()
    page.on('pageerror', lambda e: ERRORS.append(str(e)))
    page.goto(url, wait_until='networkidle')
    page.wait_for_function('()=>window.__readerInstance && window.__readerDb')
    return context, page


def import_book(page, path=None, txt=None):
    old = page.evaluate('window.__readerInstance.bookId')
    if path:
        page.locator('#file-book').set_input_files(str(path))
    else:
        page.locator('#file-book').set_input_files({'name': '原创长章目录测试.txt', 'mimeType': 'text/plain', 'buffer': txt.encode()})
    page.wait_for_function('id=>window.__readerInstance.bookId && window.__readerInstance.bookId!==id && window.__readerInstance.lastProgress?.pageLabel', arg=old)
    page.wait_for_function('()=>!window.__readerInstance._layoutBusy')


def opened(page):
    return page.locator(POP).evaluate('e=>e.matches(":popover-open")')


def open_toc(page, touch=False):
    if not opened(page):
        (page.locator('#reading-toc').tap if touch else page.locator('#reading-toc').click)()
    page.wait_for_function('()=>document.querySelector("#reading-toc-popover").matches(":popover-open") && document.querySelector("#reading-toc-list>li")')
    page.locator('#reading-toc-filter').focus()


def row(page, n):
    return page.locator(f'{LIST}>li[data-plain="{n}"]')


def settle(page):
    page.wait_for_function('()=>!window.__readerInstance._layoutBusy && !document.querySelector(".toc-pending")')
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')


def snapshot(page):
    return page.evaluate('''()=>({
      current:[...document.querySelectorAll('#reading-toc-list>li.current')].map(e=>Number(e.dataset.plain)),
      section:window.__readerInstance.lastProgress.section,
      href:window.__readerInstance.view.lastLocation.tocItem?.href,
      label:window.__readerInstance.lastProgress.pageLabel,
      rendererPage:window.__readerInstance.view.renderer.page,
      rendererPages:window.__readerInstance.view.renderer.pages,
      scrolled:window.__readerInstance.view.renderer.scrolled,
      exact:window.__readerInstance.chapterPages(window.__readerInstance.lastProgress.section)
    })''')


def install_timing(page):
    page.evaluate('''()=>{
      window._timing=[];window._long=[];
      new PerformanceObserver(l=>_long.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask'});
      document.addEventListener('click',event=>{
        const target=event.target.closest('#reading-toc, #reading-toc-popover [data-action]');if(!target)return;
        const rec={action:target.id==='reading-toc'?'open':target.dataset.action,start:performance.now(),trusted:event.isTrusted};_timing.push(rec);event._tocTiming={rec,target};
        const li=target.closest('li');
        requestAnimationFrame(()=>{rec.frameMs=performance.now()-rec.start});
        if(rec.action==='toc-go'){
          const watch=new MutationObserver(()=>{if(!target.hasAttribute('aria-busy')){rec.settledMs=performance.now()-rec.start;watch.disconnect()}});
          watch.observe(target,{attributes:true,attributeFilter:['aria-busy']});
        }
      },true)
      // Native event dispatch performs microtask checkpoints between listeners.
      // Document bubbling runs after the delegated surface/trigger handler.
      document.addEventListener('click',event=>{if(!event._tocTiming)return;
        const {rec,target}=event._tocTiming;
        rec.feedbackMs=performance.now()-rec.start;
        rec.feedback=rec.action==='open'?document.querySelector('#reading-toc-popover').matches(':popover-open'):rec.action==='toc-go'?target.closest('li').classList.contains('toc-pending'):true;
      })
      document.addEventListener('input',event=>{if(event.target.id!=='reading-toc-filter')return;
        const rec={action:'filter',start:performance.now(),query:event.target.value,trusted:event.isTrusted};_timing.push(rec);
        event._tocFilterTiming=rec;
        requestAnimationFrame(()=>{rec.frameMs=performance.now()-rec.start});
      },true)
      document.addEventListener('input',event=>{const rec=event._tocFilterTiming;if(!rec)return;rec.synchronousMs=performance.now()-rec.start;rec.visible=[...document.querySelectorAll('#reading-toc-list>li')].filter(e=>!e.hidden).length})
    }''')


def desktop(browser, args, book):
    context, page = setup(browser, args.url, viewport={'width': 1280, 'height': 850})
    try:
        import_book(page, path=book)
        ENVIRONMENT.update(page.evaluate('''()=>({userAgent:navigator.userAgent,
          script:document.querySelector('script[type="module"]')?.src,
          style:[...document.querySelectorAll('link[rel="stylesheet"]')].map(e=>e.href).find(u=>u.includes('experience.css'))})'''))
        install_timing(page)
        open_toc(page)
        s = snapshot(page)
        counts = page.evaluate('''()=>({rows:document.querySelectorAll('#reading-toc-list>li').length,
          chips:document.querySelectorAll('#reading-toc-list .toc-page-chip').length,
          aria:document.querySelectorAll('#reading-toc-list [aria-current="location"]').length})''')
        record('774目录仅一个当前位置、86个正文段统计入口', counts == {'rows': 774, 'chips': 86, 'aria': 1} and s['current'] == [0], {'counts': counts, 'state': s})
        row(page, 4).locator(GO).click()
        settle(page)
        s = snapshot(page)
        record('同一XHTML第5小节精确跳转和唯一高亮', s['href'].endswith('#p4') and s['current'] == [4] and s['section'] == 0 and s['rendererPage'] > 1, s)

        # Structural metrics are comparable to baseline-browser.json; its openMs includes
        # an explicit 250ms wait and Playwright overhead and is never a speed baseline.
        page.evaluate('''()=>{window._input=document.querySelector('#reading-toc-filter');window._row=document.querySelector('#reading-toc-list>li');window._mutations=0;
          window._watch=new MutationObserver(ms=>_mutations+=ms.filter(m=>m.type==='childList').length);_watch.observe(document.querySelector('#reading-toc-popover'),{childList:true,subtree:true});
          const t=performance.now();window.__readerInstance.recordScreen();window._recordScreenMs=performance.now()-t}''')
        settle(page)
        stable = page.evaluate('''()=>({sameInput:_input===document.querySelector('#reading-toc-filter'),sameRow:_row===document.querySelector('#reading-toc-list>li'),mutations:_mutations,synchronousRecordScreenMs:_recordScreenMs})''')
        record('同步进度写入保留目录输入与行节点', stable['sameInput'] and stable['sameRow'] and stable['mutations'] == 0, stable)

        input_ = page.locator('#reading-toc-filter')
        input_.fill('章节86')
        filter_state = page.evaluate('''()=>({visible:[...document.querySelectorAll('#reading-toc-list>li')].filter(e=>!e.hidden).length,hint:document.querySelector('#reading-toc-filter-hint').textContent,hintVisible:!document.querySelector('#reading-toc-filter-hint').hidden})''')
        record('过滤末章显示9项与真实匹配数量', filter_state['visible'] == 9 and '9 / 774' in filter_state['hint'] and filter_state['hintVisible'], filter_state)
        input_.fill('章节86 小节5')
        parents = page.evaluate('''()=>({visible:[...document.querySelectorAll('#reading-toc-list>li')].filter(e=>!e.hidden).map(e=>Number(e.dataset.plain)),hint:document.querySelector('#reading-toc-filter-hint').textContent})''')
        record('子目录搜索保留父项且匹配数不包含父项', parents['visible'] == [765, 769] and '1 / 774' in parents['hint'], parents)
        input_.fill('不存在的原创标题')
        empty = page.evaluate('''()=>({visible:[...document.querySelectorAll('#reading-toc-list>li')].filter(e=>!e.hidden).length,hint:document.querySelector('#reading-toc-filter-hint').textContent})''')
        record('零匹配有明确反馈', empty['visible'] == 0 and empty['hint'] == '没有匹配的目录', empty)
        input_.fill('')
        page.locator(POP).evaluate('e=>e.scrollTop=650')
        before = page.locator(POP).evaluate('e=>e.scrollTop')
        input_.focus()
        page.evaluate('window.__readerInstance.recordScreen()')
        settle(page)
        focus = page.evaluate('''()=>({sameInput:_input===document.querySelector('#reading-toc-filter'),focused:document.activeElement===_input,scroll:document.querySelector('#reading-toc-popover').scrollTop})''')
        record('进度刷新保留搜索焦点与滚动位置', focus['sameInput'] and focus['focused'] and abs(focus['scroll'] - before) <= 1, {'beforeScroll': before, **focus})

        # Exact current section supports page jumping; unlaid sections only advertise estimates.
        row(page, 0).locator('.toc-page-chip').click()
        estimated = row(page, 9)
        estimated.locator('.toc-page-chip').click()
        estimate_state = {'hint': estimated.locator('.toc-pages-hint').inner_text(), 'buttons': estimated.locator('.toc-page').count()}
        record('估算页数只解释估算，不生成伪精确跳页按钮', estimate_state['buttons'] == 0 and '估算' in estimate_state['hint'], estimate_state)
        row(page, 0).locator('.toc-page-chip').focus()
        if row(page, 0).locator('.toc-page-chip').get_attribute('aria-expanded') != 'true':
            row(page, 0).locator('.toc-page-chip').click()
        target = row(page, 0).locator('.toc-page[data-page="3"]')
        target.click()
        settle(page)
        s = snapshot(page)
        record('点击真实第3页与分页器实际页一致', s['rendererPage'] == 3 and s['exact'] == s['rendererPages'] - 2 and re.search(r'第 3 /', s['label']) is not None, s)

        # Same-turn burst guarantees a queued overlap. This complements, not replaces,
        # the real pointer checks above; its isTrusted=false evidence is recorded.
        page.evaluate('''()=>{for(const n of [270,540,765,769])document.querySelector(`#reading-toc-list>li[data-plain="${n}"] [data-action="toc-go"]`).click()}''')
        settle(page)
        s = snapshot(page)
        record('跨章重叠4次点击最终落在最新第86章第5小节', s['section'] == 85 and s['href'].endswith('#p4') and s['current'] == [769], s)
        page.locator('#reading-toc-filter').fill('章节86')
        row(page, 765).locator('.toc-page-chip').click()
        row(page, 765).locator('.toc-page-chip').focus()
        page.evaluate('''()=>{window._dwellNodes={input:document.querySelector('#reading-toc-filter'),row:document.querySelector('#reading-toc-list>li[data-plain="765"]'),button:document.querySelector('#reading-toc-list>li[data-plain="765"] .toc-page[data-page="3"]')};window._dwellStart=performance.now();window._dwellBefore=JSON.stringify(window.__readerInstance.readStats.readMap)}''')
        page.wait_for_function('()=>JSON.stringify(window.__readerInstance.readStats.readMap)!==_dwellBefore', timeout=36000)
        settle(page)
        dwell = page.evaluate('''()=>({elapsedMs:performance.now()-_dwellStart,
          sameInput:_dwellNodes.input===document.querySelector('#reading-toc-filter'),sameRow:_dwellNodes.row===document.querySelector('#reading-toc-list>li[data-plain="765"]'),
          sameButton:_dwellNodes.button===document.querySelector('#reading-toc-list>li[data-plain="765"] .toc-page[data-page="3"]'),
          query:document.querySelector('#reading-toc-filter').value,readMap:window.__readerInstance.readStats.readMap,pct:document.querySelector('#reading-toc-list>li[data-plain="765"] .toc-pct').textContent})''')
        record('真实停留30秒进度更新保留过滤、行与页码按钮', all(dwell[k] for k in ('sameInput', 'sameRow', 'sameButton')) and dwell['query'] == '章节86' and dwell['pct'] != '0%' and bool(dwell['readMap']), dwell)
        page.locator(POP).screenshot(path=str(args.out / 'final-desktop-774.png'))

        # Notes are created in this context's isolated IDB, then reset through UI.
        note = {'id': 'toc-fixture-note', 'type': 'bookmark', 'cfi': page.evaluate('window.__readerInstance.lastProgress.cfi'), 'text': '原创夹具笔记必须保留', 'createdAt': 1}
        page.evaluate('async note=>{await window.__readerDb.updateBookNote(window.__readerInstance.bookId,note);window.__readerInstance.recordScreen();window.__readerInstance.recordScreen()}', note)
        book_id = page.evaluate('window.__readerInstance.bookId')
        page.on('dialog', lambda dialog: dialog.accept())
        page.locator('.reading-toc-reset').click()
        page.wait_for_function('()=>window.__readerInstance.lastProgress?.section===0 && window.__readerInstance.view?.renderer?.page===1 && !window.__readerInstance._layoutBusy')
        settle(page)
        state = page.evaluate('''async()=>{await window.__readerInstance.flushProgress();const b=await window.__readerDb.getBook(window.__readerInstance.bookId);return {progress:b.progress,notes:b.notes,rendererPage:window.__readerInstance.view.renderer.page,section:window.__readerInstance.lastProgress.section}}''')
        record('归零等待保存队列、正文回开头且笔记保留', state['progress']['percent'] == 0 and not state['progress']['readMap'] and state['section'] == 0 and state['rendererPage'] == 1 and any(n['id'] == note['id'] for n in state['notes']), state)
        timings = page.evaluate('()=>({events:_timing,longTasks:_long})')
        (args.out / 'final-timing-desktop.json').write_text(json.dumps(timings, ensure_ascii=False, indent=2))
        pointer = [e for e in timings['events'] if e['action'] == 'toc-go' and e['trusted']]
        record('真实点击即刻反馈并成功完成导航', bool(pointer) and all(e.get('feedback') and e.get('feedbackMs', 1e9) < 100 and e.get('settledMs', 1e9) < 15000 for e in pointer), pointer)
        page.reload(wait_until='networkidle')
        page.wait_for_function('()=>window.__readerInstance && window.__readerDb')
        # Restored shelf may require opening; use the Reader's normal open() API with
        # the persisted isolated record to test saved position, not file re-import.
        page.evaluate('async id=>{const b=await window.__readerDb.getBook(id);await window.__readerInstance.open(b)}', book_id)
        settle(page)
        restored = page.evaluate('''()=>({section:window.__readerInstance.lastProgress.section,page:window.__readerInstance.view.renderer.page,percent:window.__readerInstance.readStats.percent,readMap:window.__readerInstance.readStats.readMap,notes:window.__readerInstance.notes.map(n=>n.id)})''')
        record('刷新后从归零书头恢复、未读与笔记均保留', restored['section'] == 0 and restored['page'] == 1 and restored['percent'] == 0 and not restored['readMap'] and note['id'] in restored['notes'], restored)
        invalid = page.evaluate('''async()=>{const r=window.__readerInstance;const bad=await r.goTo('OPS/ch0.xhtml#missing-toc-fixture-anchor');const recovered=await r.goTo('OPS/ch0.xhtml#p5');return {bad,recovered,href:r.view.lastLocation.tocItem?.href,section:r.lastProgress.section}}''')
        record('缺失锚点返回失败，后续正确锚点可恢复', invalid['bad'] is False and invalid['recovered'] is True and invalid['href'].endswith('#p5'), invalid)
        timeout_state = page.evaluate('''async()=>{const r=window.__readerInstance,old=r.view,renderer=old.renderer,original=renderer.goTo;
          window._timeoutRenderer=renderer;window._timeoutOriginal=original;
          renderer.goTo=()=>new Promise(resolve=>{window._timeoutRelease=resolve});
          const start=performance.now(),result=await r.goTo('OPS/ch0.xhtml#p6');
          return {result,elapsedMs:performance.now()-start,released:r.view===null && r.bookId===null,busy:r._layoutBusy}}''')
        record('实际15秒导航超时脱离失效实例并释放队列', timeout_state['result'] is False and timeout_state['released'] and not timeout_state['busy'] and 14900 <= timeout_state['elapsedMs'] < 18000, timeout_state)
        recovery = page.evaluate('''async id=>{_timeoutRenderer.goTo=_timeoutOriginal;_timeoutRelease(true);const r=window.__readerInstance;await r.open(await window.__readerDb.getBook(id));return {loaded:!!r.view?.renderer,id:r.bookId,section:r.lastProgress?.section}}''', book_id)
        record('导航超时后可从同一隔离书库重开书籍', recovery['loaded'] and recovery['id'] == book_id, recovery)
    finally:
        context.close()


def txt_and_accessibility(browser, args):
    txt = '\n\n'.join(f'第{n}章 原创长章目录测试\n\n' + '\n\n'.join('这是原创长章文字用于检查分页窗口和跳页准确性。' * 20 for _ in range(300)) for n in range(1, 4))
    context, page = setup(browser, args.url, viewport={'width': 1280, 'height': 850})
    try:
        import_book(page, txt=txt)
        install_timing(page)
        open_toc(page)
        chip = page.locator(f'{LIST} .toc-page-chip').first
        chip.focus()
        page.keyboard.press('Enter')
        first = page.locator(f'{LIST}>li').first
        page.wait_for_function('()=>document.querySelector("#reading-toc-list .toc-page-chip").getAttribute("aria-expanded")==="true"')
        count = first.locator('.toc-page').count()
        pages = int(first.get_attribute('data-pages'))
        record('TXT长章使用实际页数、键盘Enter展开且最多80按钮', pages > 80 and count == 80 and chip.get_attribute('aria-expanded') == 'true', {'actualPages': pages, 'buttons': count})
        first.locator('[data-action="toc-pages-window"][data-start="81"]').click()
        window = first.locator('.toc-page').evaluate_all('es=>es.map(e=>Number(e.dataset.page))')
        record('页码窗口下一组为81起且节点有界', bool(window) and window[0] == 81 and len(window) <= 80, window)
        first.locator('.toc-page[data-page="81"]').click()
        settle(page)
        s = snapshot(page)
        record('TXT窗口第81页与真实分页器一致', s['rendererPage'] == 81 and s['exact'] == pages, s)
        page.locator('#reading-toc-filter').focus()
        page.evaluate('()=>window.__readerInstance.setFlow("scrolled")')
        settle(page)
        page.wait_for_function('()=>document.querySelector("#reading-toc-list>li").dataset.pagesEst==="0" && Number(document.querySelector("#reading-toc-list>li").dataset.pages)===window.__readerInstance.chapterPages(0)')
        # Reset the page window after layout changes; its window and total are tied
        # to the new renderer, rather than reusing the old 193-page assumptions.
        if first.locator('.toc-page[data-page="3"]').count() == 0:
            first.locator('[data-action="toc-pages-window"][data-start="1"]').click()
        first.locator('.toc-page[data-page="3"]').click()
        settle(page)
        scrolled = page.evaluate('''()=>{const r=window.__readerInstance.view.renderer;return {scrolled:r.scrolled,
          actualPage:Math.floor(r.start/r.size)+1,pages:r.pages,exact:window.__readerInstance.chapterPages(0),label:window.__readerInstance.lastProgress.pageLabel}}''')
        record('切换滚动模式后目录实际页数与第3屏跳转一致', scrolled['scrolled'] and scrolled['actualPage'] == 3 and scrolled['pages'] == scrolled['exact'] and re.search(r'第 3 /', scrolled['label']) is not None, scrolled)
        page.keyboard.press('Escape')
        page.wait_for_function('()=>!document.querySelector("#reading-toc-popover").matches(":popover-open")')
        record('键盘Escape关闭目录', not opened(page))
        (args.out / 'final-timing-txt.json').write_text(json.dumps(page.evaluate('()=>({events:_timing,longTasks:_long})'), ensure_ascii=False, indent=2))
    finally:
        context.close()
    context, page = setup(browser, args.url, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
    try:
        import_book(page, txt=txt[:35000])
        open_toc(page, touch=True)
        chip = page.locator(f'{LIST} .toc-page-chip').first
        chip.tap()
        first = page.locator(f'{LIST}>li').first
        overflow = page.locator(POP).evaluate('e=>({scroll:e.scrollWidth,client:e.clientWidth,left:e.getBoundingClientRect().left,right:e.getBoundingClientRect().right})')
        record('390px触摸展开目录与页码、无横向溢出', chip.get_attribute('aria-expanded') == 'true' and overflow['scroll'] <= overflow['client'] and overflow['left'] >= 0 and overflow['right'] <= 390, overflow)
        target = first.locator('.toc-page[data-page="3"]')
        target.tap()
        settle(page)
        s = snapshot(page)
        record('390px真实触摸第3页准确落页', s['rendererPage'] == 3, s)
        page.wait_for_function('()=>document.querySelector("#reading-toc-popover").getAnimations({subtree:true}).length===0')
        page.locator(POP).screenshot(path=str(args.out / 'final-mobile-390.png'))
    finally:
        context.close()
    context, page = setup(browser, args.url, viewport={'width': 1280, 'height': 850}, reduced_motion='reduce')
    try:
        import_book(page, txt=txt[:35000])
        open_toc(page)
        chip = page.locator(f'{LIST} .toc-page-chip').first
        chip.click()
        animations = page.locator(POP).evaluate('e=>e.getAnimations({subtree:true}).length')
        record('减少动态偏好下目录与页码仍可展开且无动画', animations == 0 and chip.get_attribute('aria-expanded') == 'true', {'animations': animations})
        page.keyboard.press('Escape')
        page.wait_for_function('()=>!document.querySelector("#reading-toc-popover").matches(":popover-open")')
        trigger = page.locator('#reading-toc')
        trigger.hover()
        page.wait_for_timeout(260)
        record('悬停200ms预览目录', opened(page))
        trigger.click()
        page.mouse.move(10, 400)
        page.wait_for_timeout(550)
        record('悬停预览后首次点击固定目录', opened(page))
        trigger.click()
        page.wait_for_function('()=>!document.querySelector("#reading-toc-popover").matches(":popover-open")')
        record('已固定目录第二次点击关闭', not opened(page))
        open_toc(page)
        chip = page.locator(f'{LIST} .toc-page-chip').first
        chip.hover()
        page.wait_for_timeout(260)
        before = chip.get_attribute('aria-expanded')
        chip.click()
        page.locator('#reading-toc-filter').hover()
        page.wait_for_timeout(550)
        record('页码悬停预览后首次点击固定', before == 'true' and chip.get_attribute('aria-expanded') == 'true')
        chip.click()
        record('固定页码第二次点击收起', chip.get_attribute('aria-expanded') == 'false')
    finally:
        context.close()


def extra_regressions(browser, args, book):
    context, page = setup(browser, args.url, viewport={'width': 1280, 'height': 850})
    try:
        import_book(page, path=book)
        start = page.evaluate('''()=>{const r=window.__readerInstance,v=r.view;window._nextOriginal=v.next;
          let first=true;v.next=async()=>{if(first){first=false;await new Promise(resolve=>window._releaseNext=resolve)}return _nextOriginal.call(v)};
          return v.renderer.page}''')
        for _ in range(4):
            page.locator('#page-next').click()
        pending = page.evaluate('window.__readerInstance._queuedTurn')
        page.evaluate('window._releaseNext()')
        page.wait_for_function('()=>!window.__readerInstance._turning && !window.__readerInstance._layoutBusy')
        turns = page.evaluate('''()=>{const r=window.__readerInstance;r.view.next=_nextOriginal;return {page:r.view.renderer.page,queued:r._queuedTurn}}''')
        record('真实点击四次下一页，延迟首个动作后仍逐次消费四页', pending == 3 and turns['page'] == start + 4 and turns['queued'] == 0, {'start': start, 'pending': pending, **turns})

        original_page = turns['page']
        open_toc(page)
        row(page, 4).locator(GO).click(); settle(page)
        row(page, 7).locator(GO).click(); settle(page)
        page.keyboard.press('Escape')
        page.locator('#back-reading').click(); settle(page)
        returned = page.evaluate('window.__readerInstance.view.renderer.page')
        record('连续查阅两个目录项后返回最初阅读页', returned == original_page, {'original': original_page, 'returned': returned})

        page.evaluate("window.__readerInstance.goTo('OPS/ch85.xhtml#p4')")
        settle(page)
        page.locator('#reading-toc').click()
        settle(page)
        position = page.evaluate('''()=>{const pop=document.querySelector('#reading-toc-popover'),li=pop.querySelector('li.current'),a=pop.getBoundingClientRect(),b=li.getBoundingClientRect();return {scroll:pop.scrollTop,visible:b.top>=a.top && b.bottom<=a.bottom,current:Number(li.dataset.plain)}}''')
        record('打开目录先显示再定位，末章当前项在浮层可见', position['current'] == 769 and position['visible'] and position['scroll'] > 0, position)
        page.keyboard.press('Escape')
        page.locator('#top-settings').click()
        page.locator('[data-cmd="toc"]').click()
        page.locator('#toc-filter').fill('章节85')
        page.evaluate('''()=>{window._panelInput=document.querySelector('#toc-filter');window._panelRow=document.querySelector('#toc-list>li');window._panelScroll=document.querySelector('#panel-body').scrollTop}''')
        page.evaluate("window.__readerInstance.goTo('OPS/ch84.xhtml#p4')")
        settle(page)
        panel = page.evaluate('''()=>({sameInput:_panelInput===document.querySelector('#toc-filter'),sameRow:_panelRow===document.querySelector('#toc-list>li'),query:_panelInput.value,current:[...document.querySelectorAll('#toc-list>li.current')].map(li=>Number(li.dataset.plain)),aria:document.querySelectorAll('#toc-list [aria-current="location"]').length,scroll:document.querySelector('#panel-body').scrollTop,beforeScroll:_panelScroll})''')
        record('抽屉目录随导航增量刷新，搜索、节点和滚动保持', panel['sameInput'] and panel['sameRow'] and panel['query'] == '章节85' and panel['current'] == [760] and panel['aria'] == 1 and panel['scroll'] == panel['beforeScroll'], panel)
        page.locator('#panel-close').click()
        open_toc(page)
        page.on('dialog', lambda dialog: dialog.accept())
        page.evaluate('''()=>{const r=window.__readerInstance;window._resetGo=r.view.renderer.goTo;
          r.view.renderer.goTo=async()=>{throw new Error('原创夹具故障注入：书头载入失败')}}''')
        page.locator('.reading-toc-reset').click()
        page.wait_for_function('()=>!document.querySelector(".reading-toc-reset").disabled && document.querySelector("#toast").textContent.includes("未能回到开头")')
        failed = page.evaluate('''()=>({section:window.__readerInstance.lastProgress.section,readMap:window.__readerInstance.readStats.readMap,message:document.querySelector('#toast').textContent})''')
        record('归零定位失败时明确报告部分结果，已读记录仍清空', failed['section'] == 84 and not failed['readMap'] and '未能回到开头' in failed['message'], failed)
        retry = page.evaluate('''async()=>{const r=window.__readerInstance;r.view.renderer.goTo=_resetGo;return {success:await r.resetProgress(),section:r.lastProgress.section,page:r.view.renderer.page}}''')
        record('书头定位失败后恢复引擎可重新归零成功', retry['success'] and retry['section'] == 0 and retry['page'] == 1, retry)
    finally:
        context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:19211/')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if not re.fullmatch(r'http://127\.0\.0\.1:(?!8940(?:/|$))\d+/', args.url):
        parser.error('only non-8940 localhost test URLs are permitted')
    args.out.mkdir(parents=True, exist_ok=True)
    book = fixture(args.out)
    started = time.time()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True)
        try:
            for name, run in [('desktop', lambda: desktop(browser, args, book)), ('txt-accessibility', lambda: txt_and_accessibility(browser, args)), ('补充入口与失败回归', lambda: extra_regressions(browser, args, book))]:
                try:
                    run()
                except Exception as error:
                    record(name + '流程异常', False, str(error))
            record('浏览器全流程未抛页面异常', not ERRORS, ERRORS)
        finally:
            browser.close()
    hashes = {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in ('js/main.js', 'js/reader.js', 'js/toc-model.js', 'js/toc-interaction.js', 'js/reading-stats.js', 'css/experience.css')}
    results = {'url': args.url, 'browser': CHROME, 'environment': ENVIRONMENT, 'sourceHashes': hashes,
               'durationSeconds': round(time.time() - started, 3), 'passed': sum(c['ok'] for c in CHECKS), 'total': len(CHECKS), 'checks': CHECKS, 'pageErrors': ERRORS}
    (args.out / 'final-browser.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
    raise SystemExit(0 if all(c['ok'] for c in CHECKS) else 1)


if __name__ == '__main__':
    main()
