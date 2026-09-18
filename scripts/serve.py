#!/usr/bin/env python3
"""A fixed-origin, localhost-only static server, with repeat-launch detection."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from library_store import LibraryStore

ROOT = Path(__file__).resolve().parent.parent
IDENTITY = hashlib.sha256(str(ROOT).encode()).hexdigest()[:16]

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
        if self.path in ('/_reader/library', '/_reader/volume'):
            # 先读完请求体再做来源校验：带着未读的响应体关闭连接会被浏览器判成
            # 网络错误（ERR_EMPTY_RESPONSE），而不是拿到明确的 403 提示。
            try:
                size = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                size = 0
            body = self.rfile.read(size) if 0 < size <= 350 * 1024 * 1024 else b''
            origin = 'http://127.0.0.1:%s' % self.server.server_port
            if self.headers.get('Origin') != origin or self.headers.get('Content-Type') != 'application/json':
                return self.reply_json({'error': '仅允许本机阅读页面操作'}, 403)
            if self.path == '/_reader/library':
                try:
                    if not body:
                        raise ValueError('请求体缺失')
                    result = self.server.library.run(json.loads(body))
                    return self.reply_json(result)
                except Exception as error:
                    return self.reply_json({'error': '本地资料保存失败：' + str(error)}, 400)
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
        if self.path == '/_reader/library':
            return self.reply_json(self.server.library.run({'op':'list'}))
        if self.path == '/_reader/volume':
            try:
                return self.reply_json(self.read_volume())
            except Exception:
                return self.reply_json({'error': '当前环境无法控制电脑音量，请使用系统音量键。'}, 503)
        if self.path == '/_reader/health':
            data = json.dumps({'app': 'immersive-reader', 'workspace': IDENTITY, 'version': '1.7.0'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            super().do_GET()

    def send_head(self):
        # Single-range support for local audio seeking and binary test fixtures.
        path = Path(self.translate_path(self.path))
        if any(part in ['data','.preview'] for part in path.relative_to(ROOT).parts):
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
    print('沉浸阅读器 ' + url + '\n按 Ctrl+C 停止服务。', flush=True)
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
