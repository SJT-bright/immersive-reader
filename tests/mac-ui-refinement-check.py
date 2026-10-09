"""Launch only the project candidate with its own local data, profile and CDP port."""
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.preview/ui-refinement-20261008'
DATA = OUT / 'native-data'
PROFILE = OUT / 'native-profile'
BASE = 'http://127.0.0.1:19171/'
CDP = 'http://127.0.0.1:19172/'
env = dict(os.environ, READER_PORT='19171', READER_DATA_DIR=str(DATA),
           READER_PROFILE_DIR=str(PROFILE))
env.pop('ELECTRON_RUN_AS_NODE', None)
OUT.mkdir(parents=True, exist_ok=True)
passed = []
with (OUT / 'native-launch.log').open('w') as log:
    proc = subprocess.Popen([str(ROOT / 'dist/mac/沉浸阅读器.app/Contents/MacOS/Electron'),
                             '--remote-debugging-port=19172'], env=env,
                            stdout=log, stderr=log, start_new_session=True)
    browser = None
    try:
        for _ in range(100):
            try:
                with urllib.request.urlopen(BASE + '_reader/health', timeout=1) as response:
                    health = json.load(response)
                if health['version'] == '1.9.2':
                    break
            except (OSError, ValueError):
                time.sleep(.2)
        else:
            raise RuntimeError('candidate did not start')
        passed.append('独立 Electron 候选包启动并提供1.9.2服务')
        with sync_playwright() as p:
            # Electron rejects Playwright's trailing slash on /json/version/.
            with urllib.request.urlopen(CDP + 'json/version', timeout=5) as response:
                endpoint = json.load(response)['webSocketDebuggerUrl']
            browser = p.chromium.connect_over_cdp(endpoint)
            for _ in range(100):
                if browser.contexts[0].pages:
                    break
                time.sleep(.1)
            page = browser.contexts[0].pages[0]
            page.wait_for_function('() => window.__readerDb && !document.querySelector("#btn-welcome-open").disabled')
            for selector in ['#btn-welcome-open', '#btn-welcome-background']:
                el = page.locator(selector)
                box = el.bounding_box()
                page.mouse.move(box['x'] + box['width']/2, box['y'] + box['height'] - .5)
                page.wait_for_timeout(350)
                assert el.evaluate('e => getComputedStyle(e).transform') == 'none'
                assert el.evaluate('e => e.matches(":hover")')
            passed.append('原生候选窗口欢迎页入口悬停无位移')
            page.locator('#welcome .books-fold > summary').click()
            page.locator('#welcome [data-action="open-book"][data-id="sample-book"]').click()
            page.wait_for_function('() => !document.querySelector("#reader-column").classList.contains("hidden")')
            page.locator('#reading-speed-details > summary').click()
            page.wait_for_timeout(900)
            panel = page.locator('#reading-speed-popover')
            assert panel.evaluate('e=>e.matches(":popover-open")')
            assert panel.evaluate('e=>getComputedStyle(e).backgroundColor.startsWith("rgba(18, 24, 28,")')
            assert panel.evaluate('e=>e.style.getPropertyValue("--scrim-a")')
            page.screenshot(path=str(OUT / '06-native-speed.png'))
            passed.append('原生候选窗口打开示例书与透明速度面板')
            page.keyboard.press('Escape')
            page.locator('#reading-timer .timer-copy').click()
            cell = page.locator('.log-heat [aria-current="date"]')
            cell.scroll_into_view_if_needed()
            cell.hover()
            tip = page.locator('#log-heat-tooltip')
            assert tip.is_visible() and '阅读 0 分钟' in tip.inner_text()
            page.screenshot(path=str(OUT / '07-native-daily.png'))
            passed.append('原生候选窗口日期格悬浮显示当天分钟')
            # Close only this isolated app window; Electron quits and stops its child service.
            page.close()
        proc.wait(timeout=10)
        (OUT / 'native-results.json').write_text(json.dumps({'health': health, 'passed': passed},
                                                            ensure_ascii=False, indent=2))
        print('PASS', len(passed), 'native candidate checks')
    finally:
        if proc.poll() is None:
            import signal
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=10)
