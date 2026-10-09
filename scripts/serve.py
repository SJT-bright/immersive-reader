#!/usr/bin/env python3
"""A fixed-origin, localhost-only static server, with repeat-launch detection."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from library_store import LibraryStore, PermanentError

ROOT = Path(__file__).resolve().parent.parent
IDENTITY = hashlib.sha256(str(ROOT).encode()).hexdigest()[:16]
VERSION = '1.9.4'
# 静态目录白名单：黑名单式（只挡 data/.preview）会把 .git、dist、PROGRESS.md
# 这类不该出门的东西全部敞着，改成只放行页面真正需要的目录。
STATIC_ALLOW = {'index.html', 'manifest.webmanifest', 'sw.js', 'THIRD_PARTY_NOTICES.md',
                'js', 'css', 'vendor', 'assets', 'icons', 'licenses', 'tests'}
# 与 cloud/server.js 对齐：整条元数据写入必须由认识笔记墓碑契约的页面发起。
TOMBSTONE_HEADER = 'x-reader-note-tombstone'
LOOPBACK_HOSTS = {'127.0.0.1', 'localhost', '::1'}


def access_key():
    """口令来源与 Node 侧一致：READER_KEY 优先，其次站点根目录 key.txt。"""
    value = os.environ.get('READER_KEY')
    if value:
        return value.strip()
    marker = ROOT / 'key.txt'
    if marker.exists():
        return marker.read_text(encoding='utf-8').strip()
    return ''


def key_matches(provided):
    """恒定时间比较（与 cloud/server.js 的 keyMatches 同规则）。"""
    import hmac
    expected = access_key()
    if not expected or not isinstance(provided, str):
        return False
    return hmac.compare_digest(expected, provided)


def requires_tombstone_capability(item, header_value):
    """books 的整条元数据写入需要 x-reader-note-tombstone:1；其余操作放行。
    返回 None 表示放行，否则返回 (error, code)。"""
    if not isinstance(item, dict) or item.get('store') != 'books':
        return None
    if item.get('op') not in ('put', 'meta'):
        return None
    if str(header_value or '') == '1':
        return None
    return ('资料保存失败：页面版本过旧，请强制刷新（⇧⌘R）后再同步', 'client_upgrade_required')


def open_browser(url):
    chrome = Path('/Applications/Google Chrome.app')
    if sys.platform == 'darwin' and chrome.is_dir():
        if subprocess.run(['open', '-a', str(chrome), url], check=False).returncode == 0:
            return
    webbrowser.open(url)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.remaining = None
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def reply_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def request_origin(self):
        return 'http://127.0.0.1:%s' % self.server.server_port

    def host_is_loopback(self):
        """Host 头必须落在 127.0.0.1 / localhost：这个服务只为本机页面读写资料库，
        指错了 Host（反向代理、端口转发、DNS rebinding）就不该给数据。"""
        value = self.headers.get('Host') or ''
        return value.split(':')[0].strip('[]').lower() in LOOPBACK_HOSTS

    def has_tombstone_capability(self):
        return self.headers.get(TOMBSTONE_HEADER)

    def key_ok(self):
        """口令：x-reader-key 头优先（页面把 ?key= 转成头），兼容 ?key= 引导链接。"""
        if not access_key():
            return True
        provided = self.headers.get('x-reader-key')
        if provided is None:
            provided = parse_qs(urlparse(self.path).query).get('key', [None])[0]
        return key_matches(provided)

    def read_volume(self):
        if sys.platform != 'darwin':
            raise RuntimeError('当前系统不支持网页调节电脑音量，请使用系统音量键。')
        value = subprocess.check_output(['osascript', '-e', 'get volume settings'], text=True, timeout=4)
        volume = re.search(r'output volume:(\d+)', value)
        muted = re.search(r'output muted:(true|false)', value)
        if not volume or not muted:
            raise RuntimeError('无法读取电脑音量，请使用系统音量键。')
        return {'volume': int(volume[1]), 'muted': muted[1] == 'true'}

    def do_POST(self):
        pathname = urlparse(self.path).path
        if pathname in ('/_reader/library', '/_reader/volume'):
            # 先读完请求体再做来源校验：带着未读的响应体关闭连接会被浏览器判成
            # 网络错误（ERR_EMPTY_RESPONSE），而不是拿到明确的 403 提示。
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                size = 0
            body = self.rfile.read(size) if 0 < size <= 350 * 1024 * 1024 else b''
            if not self.host_is_loopback():
                return self.reply_json({'error': '仅允许本机地址访问', 'code': 'host_not_loopback'}, 403)
            if not self.key_ok():
                return self.reply_json({'error': '需要访问口令', 'code': 'key_required'}, 403)
            if self.headers.get('Origin') != self.request_origin() or self.headers.get('Content-Type') != 'application/json':
                return self.reply_json({'error': '仅允许本机阅读页面操作'}, 403)
            if pathname == '/_reader/library':
                try:
                    if not body:
                        raise ValueError('请求体缺失')
                    item = json.loads(body)
                    blocked = requires_tombstone_capability(item, self.has_tombstone_capability())
                    if blocked:
                        return self.reply_json({'error': blocked[0], 'code': blocked[1]}, 400)
                    result = self.server.library.run(item)
                    return self.reply_json(result)
                except PermanentError as error:
                    # code 让浏览器区分「永久失败」（挪进 dead 队列继续排空）与
                    # 「暂时失败」（保留 journal 等下次重试）
                    return self.reply_json({'error': '本地资料保存失败：' + str(error), 'code': error.code}, 400)
                except Exception as error:
                    return self.reply_json({'error': '本地资料保存失败：' + str(error), 'code': 'storage_write_failed'}, 400)
            try:
                if not body:
                    raise ValueError()
                data = json.loads(body)
                if not isinstance(data, dict) or set(data) != {'volume', 'muted'} or type(data['volume']) is not int or not 0 <= data['volume'] <= 100 or type(data['muted']) is not bool:
                    raise ValueError()
            except (ValueError, TypeError):
                return self.reply_json({'error': '音量必须是0到100的整数'}, 400)
        try:
            self.read_volume()
            subprocess.run(['osascript', '-e', 'set volume output volume %d output muted %s' % (data['volume'], str(data['muted']).lower())], check=True, timeout=4, capture_output=True)
            self.reply_json(self.read_volume())
        except Exception:
            self.reply_json({'error': '无法调节电脑音量，请使用系统音量键。'}, 503)

    def do_GET(self):
        pathname = urlparse(self.path).path
        if pathname == '/_reader/library':
            # 这条接口返回全库元数据（书名、笔记、进度），早先连 POST 那层 Origin
            # 校验都没有：任何能连到端口的页面都能把整库目录读走。
            if not self.host_is_loopback():
                return self.reply_json({'error': '仅允许本机地址访问', 'code': 'host_not_loopback'}, 403)
            if not self.key_ok():
                return self.reply_json({'error': '需要访问口令', 'code': 'key_required'}, 403)
            origin = self.headers.get('Origin')
            if origin is not None and origin != self.request_origin():
                return self.reply_json({'error': '仅允许本机阅读页面操作', 'code': 'origin_mismatch'}, 403)
            return self.reply_json(self.server.library.run({'op': 'list'}))
        if pathname == '/_reader/volume':
            try:
                return self.reply_json(self.read_volume())
            except Exception:
                return self.reply_json({'error': '当前环境无法控制电脑音量，请使用系统音量键。'}, 503)
        if pathname == '/_reader/health':
            data = json.dumps({'app': 'immersive-reader', 'workspace': IDENTITY, 'version': VERSION, 'mode': 'local', 'storage': 'sqlite'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            super().do_GET()

    def static_allowed(self, path):
        """静态目录白名单：只有页面真正需要的目录/文件出得来。
        黑名单写法（只挡 data 与 .preview）留住了 .git、dist、PROGRESS.md、
        各类 .command 脚本和 key.txt 的旁路。"""
        try:
            relative = Path(path).relative_to(ROOT)
        except ValueError:
            return False
        parts = relative.parts
        if not parts:
            return Path(path).is_dir()  # 站点根目录：标准库会落到 index.html
        # 隐藏文件/目录（.git、.preview、.portable-marker、key.txt 之外的备份）
        if any(part.startswith('.') for part in parts):
            return False
        # 不做目录列表，避免把源码文件名整份摊开（根目录除外，它命中 index.html）
        if Path(path).is_dir():
            return False
        return parts[0] in STATIC_ALLOW

    def send_head(self):
        # Single-range support for local audio seeking and binary test fixtures.
        pathname = urlparse(self.path).path
        if pathname.startswith('/_reader/'):
            self.send_error(404, 'Not found')
            return None
        path = Path(self.translate_path(self.path))
        if not self.static_allowed(path):
            self.send_error(403);return None
        byte_range = self.headers.get('Range')
        if byte_range and path.is_file():
            match = re.fullmatch(r'bytes=(\d*)-(\d*)', byte_range)
            size = path.stat().st_size
            if not match or not size:
                self.send_error(416)
                return None
            first, last = match.groups()
            start = int(first) if first else max(0, size - int(last or 0))
            end = min(size - 1, int(last)) if first and last else size - 1
            if start > end or start >= size:
                self.send_response(416)
                self.send_header('Content-Range', 'bytes */%s' % size)
                self.end_headers()
                return None
            handle = path.open('rb')
            handle.seek(start)
            self.remaining = end - start + 1
            self.send_response(206)
            self.send_header('Content-Type', self.guess_type(str(path)))
            self.send_header('Content-Range', 'bytes %s-%s/%s' % (start, end, size))
            self.send_header('Content-Length', str(self.remaining))
            self.end_headers()
            return handle
        return super().send_head()

    def copyfile(self, source, outputfile):
        if self.remaining is None:
            return super().copyfile(source, outputfile)
        while self.remaining > 0:
            data = source.read(min(65536, self.remaining))
            if not data:
                break
            outputfile.write(data)
            self.remaining -= len(data)

    def log_message(self, fmt, *args):
        if args and str(args[1]).startswith(('4', '5')):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8940)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    if args.port == 8765 or not 1024 <= args.port <= 65535:
        sys.exit('请选择 1024–65535 中除 8765 以外的固定端口。')
    url = 'http://127.0.0.1:%s/' % args.port
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    except OSError:
        try:
            with urllib.request.urlopen(url + '_reader/health', timeout=2) as response:
                health = json.load(response)
            if health.get('app') == 'immersive-reader' and health.get('workspace') == IDENTITY:
                print('阅读器已经运行，复用 ' + url, flush=True)
                if not args.no_open:
                    open_browser(url)
                return
        except Exception:
            pass
        sys.exit('端口 %s 已被另一个服务占用。请关闭占用服务后重试；为保留本地资料，不会自动换端口。' % args.port)
    server.library=LibraryStore(ROOT,args.port)
    # 绑定地址、库路径与口令状态写进启动日志：出问题第一眼就能确认打在哪个库上。
    print('沉浸阅读器（本机版）已启动，存储引擎: sqlite')
    print('监听 127.0.0.1:%s，数据目录: %s' % (args.port, server.library.path.parent))
    print('访问口令: ' + ('已启用（x-reader-key 头）' if access_key() else '未设置（本机模式，只监听 127.0.0.1）'))
    print(url + '\n按 Ctrl+C 停止服务。', flush=True)
    if not args.no_open:
        threading.Timer(0.5, lambda: open_browser(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == '__main__':
    main()
