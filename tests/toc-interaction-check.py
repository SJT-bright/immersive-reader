"""Real pointer, keyboard and touch checks, using only an isolated test library."""
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.preview/toc-interaction-20261009'
URL = 'http://127.0.0.1:19175/'
OUT.mkdir(parents=True, exist_ok=True)
checks, errors = [], []
text = '\n\n'.join(f'第{n}章 目录交互测试与长标题对齐检查\n\n' +
                     '\n\n'.join('这是用于目录交互检查的原创测试文本。页码应该居中，离开后可以收回。' * 8 for _ in range(65))
                     for n in range(1, 5))


def check(name, detail=None):
    checks.append({'name': name, 'detail': detail})
    print('PASS', name, json.dumps(detail, ensure_ascii=False) if detail else '', flush=True)


def setup(browser, **options):
    context = browser.new_context(service_workers='block', timezone_id='Asia/Taipei', **options)
    context.route('**/_reader/library', lambda route: route.abort())
    context.add_init_script('''localStorage.setItem('immersive-reader-settings-v1', JSON.stringify({
        background:{mode:'fixed',fixedId:'builtin:fluid'},
        atmosphere:{enabled:false},misc:{keepToolbarWhenIdle:true,readingPreset:'custom'}
    }));''')
    page = context.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL, wait_until='networkidle')
    page.wait_for_function('() => window.__readerInstance && window.__readerDb')
    page.locator('#file-book').set_input_files({'name': '目录交互测试.txt', 'mimeType': 'text/plain', 'buffer': text.encode()})
    page.wait_for_function('() => window.__readerInstance.bookId && window.__readerInstance.bookId !== "sample-book"')
    page.wait_for_function('() => window.__readerInstance.lastProgress?.pageLabel')
    page.wait_for_timeout(600)
    return context, page


def move_to(page, element):
    box = element.bounding_box()
    page.mouse.move(box['x'] + box['width']/2, box['y'] + box['height']/2)


def visible(page):
    return page.locator('#reading-toc-popover').evaluate('e=>e.matches(":popover-open")')


def open_hover(page):
    move_to(page, page.locator('#reading-toc'))
    page.wait_for_timeout(100)
    assert not visible(page), 'passing over the trigger must not open immediately'
    page.wait_for_timeout(180)
    assert visible(page)
    page.wait_for_timeout(200)


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless=True)
    try:
        context, page = setup(browser, viewport={'width': 1280, 'height': 850})
        trigger = page.locator('#reading-toc')
        move_to(page, trigger)
        page.wait_for_timeout(70)
        page.mouse.move(10, 400)
        page.wait_for_timeout(350)
        assert not visible(page)
        check('快速划过不展开')
        open_hover(page)
        check('停留约200ms自动展开')
        pop = page.locator('#reading-toc-popover')
        box = pop.bounding_box()
        page.mouse.move(box['x'] + box['width']/2, box['y'] - 5)
        page.wait_for_timeout(90)
        page.mouse.move(box['x'] + 20, box['y'] + 18)
        page.wait_for_timeout(450)
        assert visible(page)
        check('从入口穿过间隙移入目录保持展开')

        row = page.locator('#reading-toc-list li:has(.toc-page-chip)').first
        chip = row.locator('.toc-page-chip')
        move_to(page, chip)
        page.wait_for_timeout(100)
        assert chip.get_attribute('aria-expanded') == 'false'
        page.wait_for_timeout(130)
        assert chip.get_attribute('aria-expanded') == 'true'
        assert row.locator('.toc-pages').evaluate('e=>e.getAnimations().length > 0')
        page.wait_for_timeout(220)
        assert row.locator('.toc-page').count() > 8
        move_to(page, row.locator('.toc-page').nth(1))
        page.wait_for_timeout(450)
        assert chip.get_attribute('aria-expanded') == 'true'
        check('章节停留展开带动画，移入页码保持展开')
        alignment = row.locator('.toc-page').evaluate_all('''items=>items.map(e=>{
            const a=e.getBoundingClientRect(), b=e.querySelector('span').getBoundingClientRect();
            return {x:Math.abs((a.left+a.right-b.left-b.right)/2),y:Math.abs((a.top+a.bottom-b.top-b.bottom)/2)}
        })''')
        assert all(a['x'] <= .5 and a['y'] <= .5 for a in alignment), alignment
        header = row.locator('.toc-row').evaluate('''e=>[...e.children].map(c=>{
            const r=c.getBoundingClientRect();return {left:r.left,right:r.right,center:(r.top+r.bottom)/2}
        })''')
        assert max(h['center'] for h in header)-min(h['center'] for h in header) <= .5
        assert header[0]['right'] < header[2]['left'] and header[2]['right'] < header[1]['left']
        assert row.locator('.toc-page.none').first.evaluate('e=>getComputedStyle(e).opacity') == '1'
        check('全部页码正中间、章节名/页数/百分比不重叠且对齐', {'maxX':max(a['x'] for a in alignment),'maxY':max(a['y'] for a in alignment)})
        pop.screenshot(path=str(OUT/'desktop.png'))
        page.mouse.move(box['x'] + 18, box['y'] + 18)
        page.wait_for_timeout(250)
        assert chip.get_attribute('aria-expanded') == 'false'
        assert row.locator('.toc-pages').evaluate('e=>e.getAnimations().length > 0')
        move_to(page, chip)
        page.wait_for_timeout(250)
        assert chip.get_attribute('aria-expanded') == 'true'
        assert not row.locator('.toc-pages').is_hidden()
        check('章节折叠中返回也平滑重开')
        page.mouse.move(box['x'] + 18, box['y'] + 18)
        page.wait_for_timeout(250)
        assert chip.get_attribute('aria-expanded') == 'false'
        page.wait_for_timeout(220)
        assert row.locator('.toc-pages').is_hidden()
        check('离开章节延迟收回并播放折叠动画')

        page.mouse.move(10, 400)
        page.wait_for_timeout(270)
        assert visible(page) and pop.evaluate('e=>Number(getComputedStyle(e).opacity)<1')
        move_to(page, trigger)
        page.wait_for_timeout(500)
        assert visible(page)
        check('收回中快速返回平滑重开，不被旧动画隐藏')
        page.mouse.move(10, 400)
        page.wait_for_timeout(450)
        assert not visible(page)
        check('离开入口和目录约400ms内完成收回')

        trigger.click()
        page.wait_for_timeout(200)
        page.locator('#reading-toc-filter').click()
        page.locator('#reading-toc-filter').fill('第')
        page.mouse.move(10, 400)
        page.wait_for_timeout(550)
        assert visible(page)
        page.keyboard.press('Escape')
        page.wait_for_timeout(250)
        assert not visible(page)
        page.keyboard.press('Tab')
        trigger.focus()
        page.keyboard.press('Enter')
        page.wait_for_timeout(250)
        row = page.locator('#reading-toc-list li:has(.toc-page-chip)').first
        row.locator('.toc-page-chip').focus()
        page.keyboard.press('Enter')
        page.wait_for_timeout(250)
        assert row.locator('.toc-page-chip').get_attribute('aria-expanded') == 'true'
        check('输入过滤时不误收，键盘Enter展开、Esc关闭可用')
        context.close()

        context, page = setup(browser, viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        page.locator('#reading-toc').tap()
        page.wait_for_timeout(250)
        row = page.locator('#reading-toc-list li:has(.toc-page-chip)').first
        row.locator('.toc-page-chip').tap()
        page.wait_for_timeout(500)
        assert row.locator('.toc-page-chip').get_attribute('aria-expanded') == 'true'
        assert page.locator('#reading-toc-popover').evaluate('e=>e.scrollWidth <= e.clientWidth')
        page.locator('#reading-toc-popover').screenshot(path=str(OUT/'mobile-390.png'))
        target = row.locator('.toc-page').nth(2)
        target_page = int(target.get_attribute('data-page'))
        target.tap()
        page.wait_for_timeout(1000)
        actual = page.evaluate('window.__readerInstance.lastProgress.pageLabel')
        assert int(re.search(r'\d+', actual).group()) == target_page, actual
        check('390px触屏点击展开、无横向溢出、真实页码跳转', {'target':target_page,'actual':actual})
        context.close()

        context, page = setup(browser, viewport={'width': 1280, 'height': 850}, reduced_motion='reduce')
        open_hover(page)
        row = page.locator('#reading-toc-list li:has(.toc-page-chip)').first
        move_to(page,row.locator('.toc-page-chip'))
        page.wait_for_timeout(250)
        assert page.locator('#reading-toc-popover').evaluate('e=>e.getAnimations().length') == 0
        assert row.locator('.toc-pages').evaluate('e=>e.getAnimations().length') == 0
        check('减少动态偏好下仍可悬停展开，无动画')
        context.close()
        assert not errors, errors
        check('全流程页面异常0')
        (OUT/'results.json').write_text(json.dumps({'checks':checks,'pageErrors':errors},ensure_ascii=False,indent=2))
    finally:
        browser.close()
