#!/bin/sh
# Keep the origin stable: the browser stores books and settings per port.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
    echo '需要 Python 3。请安装后重新打开，或使用任意静态服务器访问此目录。'
    exit 1
fi
exec python3 scripts/serve.py --port "${READER_PORT:-8940}" "$@"
