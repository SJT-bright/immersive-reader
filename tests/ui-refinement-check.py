"""Actual Chrome checks for transparent panels, stable hover, and dated reading cells.

Start an isolated server, then run python3 tests/ui-refinement-check.py.
Never uses the installed app or production library.
"""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.preview/ui-refinement-20261008'
URL = os.environ.get('READER_URL', 'http://127.0.0.1:19170/')
assert urlparse(URL).hostname == '127.0.0.1' and urlparse(URL).port not in (8940, 8765)
OUT.mkdir(parents=True, exist_ok=True)
FIXED = datetime(2026, 10, 8, 12, tzinfo=timezone(timedelta(hours=8)))
results = []
errors = []


def check(name, detail=None):
    results.append({'name': name, 'detail': detail})
    print('PASS', name, json.dumps(detail, ensure_ascii=False) if detail else '')


def open_book(page):
    page.goto(URL)
    page.wait_for_load_state('networkidle')
    page.wait_for_function('() => window.__readerDb && window.__readerScene')
    page.locator('#welcome .books-fold > summary').click()
    page.locator('#welcome [data-action="open-book"][data-id="sample-book"]').click()
    page.wait_for_function('() => !document.querySelector("#reader-column").classList.contains("hidden")')


def speed_open(page):
    page.locator('#reading-speed-details > summary').click()
    page.wait_for_function('() => document.querySelector("#reading-speed-popover").matches(":popover-open")')
    page.wait_for_timeout(700)


def style(page, selector):
    return page.locator(selector).evaluate('''e => {
        const s=getComputedStyle(e); return {bg:s.backgroundColor, color:s.color,
        backdrop:s.backdropFilter, transform:s.transform, translate:s.translate,
        scrim:e.style.getPropertyValue('--scrim-a'), rect:e.getBoundingClientRect().toJSON()};
    }''')


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless=True, args=['--use-angle=metal'])
    try:
        context = browser.new_context(viewport={'width': 1440, 'height': 900},
                                      timezone_id='Asia/Taipei', service_workers='block')
        context.route('**/_reader/library', lambda route: route.abort())
        context.add_init_script('''{
            const days={}; const today=new Date(2026,9,8,12);
            for(let n=1;n<110;n++) {
                const d=new Date(today); d.setDate(d.getDate()-n);
                const key=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
                days[key]={ms:(n%6===0?0:((n*17)%135))*60000};
            }
            days['2026-10-08']={ms:71*60000+59000};
            days['2026-10-07']={ms:131*60000};
            days['2026-10-06']={ms:0}; days['2026-10-05']={ms:30000};
            localStorage.setItem('immersive-reader-settings-v1', JSON.stringify({
                misc:{readingPreset:'custom',keepToolbarWhenIdle:true},
                readingLog:{current:null,days,sessions:[],unlocked:[],goalMinutes:0}
            }));
        }''')
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        open_book(page)

        speed_open(page)
        glass = style(page, '#reading-speed-popover')
        assert 'rgba(18, 24, 28,' in glass['bg'] and glass['backdrop'].startswith('blur('), glass
        assert glass['scrim'], 'speed surface must participate in background sampling'
        child = style(page, '#reading-speed-popover [data-font="song"]')
        assert child['color'] == 'rgb(255, 255, 255)' and child['backdrop'] == 'none', child
        check('字号速度透明玻璃，内部控件无重复磨砂', glass)
        page.screenshot(path=str(OUT / '01-transparent-speed.png'))
        page.locator('#reading-speed-popover [data-font="kai"]').click()
        assert page.locator('#reading-speed-popover [data-font="kai"]').get_attribute('aria-pressed') == 'true'
        assert page.locator('#reading-speed-popover [data-font="song"]').get_attribute('aria-pressed') == 'false'
        old_size = int(page.locator('#quick-font-size').inner_text())
        page.locator('#reading-speed-popover [data-action="font-plus"]').click()
        assert int(page.locator('#quick-font-size').inner_text()) == old_size + 1
        check('字体与字号切换回显正常')
        page.locator('#reading-speed-popover [data-flow="scrolled"]').click()
        page.wait_for_function('() => document.body.classList.contains("scroll-reading")')
        assert page.locator('#reading-speed-popover [data-flow="scrolled"]').get_attribute('aria-pressed') == 'true'
        page.locator('#reading-speed-popover [data-flow="paginated"]').click()
        page.wait_for_function('() => !document.body.classList.contains("scroll-reading")')
        check('翻页和连续滚动互相切换，浮层保持可操作')

        # Switch repeatedly: there must never be two active reading popovers.
        for _ in range(3):
            page.locator('#reading-toc').click()
            page.wait_for_timeout(650)
            assert page.locator('#reading-toc-popover').evaluate('e=>e.matches(":popover-open")')
            assert not page.locator('#reading-speed-popover').evaluate('e=>e.matches(":popover-open")')
            speed_open(page)
            assert not page.locator('#reading-toc-popover').evaluate('e=>e.matches(":popover-open")')
        check('目录与字号速度连续切换互斥，无浮层叠加')
        page.locator('#reading-toc').click()
        page.wait_for_timeout(650)
        toc = style(page, '#reading-toc-popover')
        assert 'rgba(18, 24, 28,' in toc['bg'] and toc['backdrop'] == glass['backdrop']
        assert style(page, '#reading-toc-filter')['color'] == 'rgb(255, 255, 255)'
        page.screenshot(path=str(OUT / '02-transparent-toc.png'))
        check('目录使用相同玻璃材质', toc)

        # Real pointer stays 1 px inside the original lower button edge.
        page.locator('#reading-toc').click()
        page.wait_for_timeout(650)
        target = '#reading-speed-details > summary'
        box = page.locator(target).bounding_box()
        page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] - 1)
        states = page.evaluate('''async () => {
            const e=document.querySelector('#reading-speed-details > summary'), states=[];
            for(let i=0;i<40;i++) { const r=e.getBoundingClientRect(); const s=getComputedStyle(e);
                states.push({top:r.top,hover:e.matches(':hover'),cursor:s.cursor});
                await new Promise(resolve=>requestAnimationFrame(resolve)); }
            return states;
        }''')
        assert all(s['hover'] for s in states), states
        assert max(s['top'] for s in states) - min(s['top'] for s in states) < .1, states
        page.wait_for_timeout(3500)
        assert page.locator(target).evaluate('e=>getComputedStyle(e).cursor') == 'pointer'
        assert not page.locator('body').evaluate('e=>e.classList.contains("cursor-idle")')
        check('按钮底边悬停40帧位置稳定，停留后光标仍显示')

        # Production flow to the records view; fixture lives only in this context.
        page.clock.set_fixed_time(FIXED)
        page.locator('#reading-timer .timer-copy').click()
        page.wait_for_function('() => document.querySelector("#panel-title").textContent === "阅读记录"')
        today = page.locator('[data-heat-day="2026-10-08"]')
        today.scroll_into_view_if_needed()
        today.hover()
        tip = page.locator('#log-heat-tooltip')
        tip.wait_for(state='visible')
        assert '2026年10月8日' in tip.inner_text() and '阅读 71 分钟' in tip.inner_text(), tip.inner_text()
        assert page.locator('.log-heat [data-heat-day]').count() == 109
        assert page.locator('.log-heat-months').inner_text().count('月') >= 4
        check('16周宫格按日期排列，月份标记与完整日期/分钟提示正确')
        page.screenshot(path=str(OUT / '03-daily-hover.png'))
        for day, value in [('2026-10-07', '阅读 131 分钟'),
                           ('2026-10-06', '阅读 0 分钟'),
                           ('2026-10-05', '阅读 0 分钟（不足 1 分钟）')]:
            page.locator(f'[data-heat-day="{day}"]').hover()
            assert value in tip.inner_text(), tip.inner_text()
        check('超过1小时仍显示完整分钟，零时长和不足1分钟明确')

        today.focus()
        page.keyboard.press('ArrowUp')
        assert page.locator(':focus').get_attribute('data-heat-day') == '2026-10-07'
        page.keyboard.press('ArrowLeft')
        assert page.locator(':focus').get_attribute('data-heat-day') == '2026-09-30'
        page.keyboard.press('End')
        assert page.locator(':focus').get_attribute('data-heat-day') == '2026-10-08'
        page.keyboard.press('Escape')
        assert tip.is_hidden() and page.locator('#panel').is_visible()
        check('键盘逐日/逐周导航，Esc只收日期提示')

        page.locator('#reading-timer [data-log="toggle"]').click()
        today.hover()
        page.evaluate('window.__heatSavedNode=document.querySelector("[data-heat-day=\\"2026-10-08\\"]")')
        page.clock.set_fixed_time(FIXED + timedelta(seconds=2))
        page.wait_for_function('() => document.querySelector(".log-heat-tooltip-duration").textContent.includes("72 分钟")')
        assert page.evaluate('window.__heatSavedNode===document.querySelector("[data-heat-day=\\"2026-10-08\\"]")')
        page.locator('#reading-timer [data-log="toggle"]').click()
        check('计时跨分钟实时更新提示，格子节点和悬停保持')

        page.locator('#panel-close').click()
        page.wait_for_timeout(500)
        # The record test fixes Date; disable motion before visual capture so
        # a CSS animation cannot be photographed at a frozen intermediate opacity.
        page.emulate_media(reduced_motion='reduce')
        page.evaluate('window.__readerScene.settings.background.fixedId="builtin:fp-desk"')
        page.evaluate('window.__readerScene.setRef("builtin:fp-desk", {animate:false})')
        page.wait_for_function('() => document.body.classList.contains("fp-mode")')
        page.wait_for_timeout(900)
        speed_open(page)
        paper = style(page, '#reader-host')
        fpglass = style(page, '#reading-speed-popover')
        assert fpglass['color'] == 'rgb(255, 255, 255)' and fpglass['backdrop'].startswith('blur(')
        assert page.evaluate('window.__readerInstance.bookSpread')
        assert page.evaluate('getComputedStyle(document.querySelector("#reader-host"),"::before").backgroundImage') != 'none'
        page.screenshot(path=str(OUT / '04-paper-book-glass.png'))
        check('实体书纸面保留，浮层依旧透明且白字可读', {'paper': paper, 'popover': fpglass})

        page.emulate_media(reduced_motion='reduce')
        page.keyboard.press('Escape')
        speed_open(page)
        assert page.locator('#reading-speed-popover').evaluate('e=>e.getAnimations().length') == 0
        check('减少动态效果偏好下浮层无入场动画')
        page.keyboard.press('Escape')

        # Narrow viewport: date grid adapts, tooltip remains inside visible panel.
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#reading-timer .timer-copy').click()
        page.wait_for_function('() => document.querySelector("#panel-title").textContent === "阅读记录"')
        today = page.locator('[data-heat-day="2026-10-08"]')
        today.scroll_into_view_if_needed()
        today.hover()
        tip.wait_for(state='visible')
        fit = tip.bounding_box()
        assert fit['x'] >= 0 and fit['x'] + fit['width'] <= 390, fit
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert today.evaluate('e=>e.getBoundingClientRect().width') >= 10
        page.screenshot(path=str(OUT / '05-mobile-daily.png'))
        check('390px宫格与提示不溢出')
        context.close()

        touch = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True,
                                    timezone_id='Asia/Taipei', service_workers='block')
        touch.route('**/_reader/library', lambda route: route.abort())
        touch_page = touch.new_page()
        touch_page.on('pageerror', lambda e: errors.append(str(e)))
        open_book(touch_page)
        touch_page.locator('#reading-timer .timer-copy').tap()
        cell = touch_page.locator('.log-heat [aria-current="date"]')
        cell.scroll_into_view_if_needed()
        cell.tap()
        assert touch_page.locator('#log-heat-tooltip').is_visible()
        check('触屏点击日期格显示提示')
        touch.close()
        assert not errors, errors
        check('桌面、窄屏、触屏全程无页面错误')
    finally:
        browser.close()
        (OUT / 'results.json').write_text(json.dumps({'passed': results, 'pageErrors': errors},
                                                   ensure_ascii=False, indent=2))
