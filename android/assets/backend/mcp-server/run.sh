#!/usr/bin/env bash
# 启动 easyjailbreak MCPhost（Streamable HTTP）
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "缺少虚拟环境：先执行 python3 -m venv --system-site-packages .venv && .venv/bin/pip install -e ." >&2
  exit 1
fi
exec .venv/bin/python -m easyjailbreak_mcp --host 127.0.0.1 --port "${PORT:-8765}" "$@"
