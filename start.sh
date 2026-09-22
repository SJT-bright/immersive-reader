#!/bin/sh
# Keep the origin stable: the browser stores books and settings per port.
cd "$(dirname "$0")" || exit 1
if command -v node >/dev/null 2>&1 && [ "$(node -p 'parseInt(process.versions.node) >= 16 ? 1 : 0' 2>/dev/null)" = "1" ]; then
    # Node 优先：与便携版 / 云托管版 / 桌面 APP 同一套服务（cloud/server.js）
    # 本机模式：数据目录与 Python 版完全一致，源码遗留 data/ 自动迁移
    exec env READER_LOCAL=1 PORT="${READER_PORT:-8940}" node cloud/server.js "$@"
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo '需要 Node.js（16+，推荐 22.5+）或 Python 3，安装其中之一后重试：'
    echo '  Node.js  https://nodejs.org/'
    exit 1
fi
exec python3 scripts/serve.py --port "${READER_PORT:-8940}" "$@"
