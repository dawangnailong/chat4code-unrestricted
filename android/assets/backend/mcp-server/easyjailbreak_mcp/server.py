"""easyjailbreak-mcp 服务入口。

把 EasyJailbreak 的攻击器包装成 MCP tools，前端「实验台」通过 MCP 协议（Streamable HTTP）
调用；也可以用 stdio 挂到支持 MCP 的 Agent 里。

启动：
    python -m easyjailbreak_mcp --port 8765
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import time

from mcp.server.mcpserver import MCPServer

from .catalog import DATASETS, METHODS, METHOD_BY_ID
from .runner import CACHE_DIR, EASYJAILBREAK_PATH, MANAGER


def _easyjailbreak_available() -> tuple[bool, str | None]:
    try:
        from .runner import _ensure_easyjailbreak

        _ensure_easyjailbreak()
        import easyjailbreak  # noqa: F401

        return True, None
    except Exception as error:  # noqa: BLE001
        return False, f'{type(error).__name__}: {error}'


mcp = MCPServer('easyjailbreak')


@mcp.tool()
def health() -> dict:
    """检查本地 EasyJailbreak 后端是否就绪。"""
    available, error = _easyjailbreak_available()
    return {
        'ok': available,
        'easyjailbreakPath': EASYJAILBREAK_PATH,
        'easyjailbreakAvailable': available,
        'error': error,
        'python': platform.python_version(),
        'time': time.time(),
    }


@mcp.tool()
def list_methods() -> dict:
    """列出可用的攻击方法与所需模型通道。"""
    available, error = _easyjailbreak_available()
    return {
        'available': available,
        'error': error,
        'methods': METHODS,
    }


@mcp.tool()
def list_datasets() -> dict:
    """列出可选数据集。custom 表示使用前端传入的自定义 queries。"""
    cache_dir = os.path.abspath(os.path.join(CACHE_DIR))
    cached = sorted(
        item.rsplit('-', 1)[-1][:-5]
        for item in (os.listdir(cache_dir) if os.path.isdir(cache_dir) else [])
        if item.startswith('dataset-') and item.endswith('.json')
    )
    return {'datasets': DATASETS, 'cached': cached}


@mcp.tool()
def start_attack(
    method: str,
    queries: list[str] | None = None,
    dataset: str = 'advbench',
    limit: int = 5,
    models: dict | None = None,
    method_params: dict | None = None,
    target_max_tokens: int = 150,
    attack_max_tokens: int = 500,
    judge_max_tokens: int = 10,
) -> dict:
    """启动一次攻击任务，立即返回 jobId；用 get_job 查询进度与结果。

    models 结构：
        {"target": {"baseUrl": "...", "model": "...", "apiKey": "..."},
         "attack": {...}, "eval": {...}}
    attack / eval 省略时复用 target。apiKey 只保存在任务内存里，不落盘。
    """
    if method not in METHOD_BY_ID:
        raise ValueError(f'未知方法：{method}；可用：{", ".join(METHOD_BY_ID)}')

    request = {
        'queries': queries or [],
        'dataset': dataset,
        'limit': max(1, min(int(limit or 5), 200)),
        'models': models or {},
        'methodParams': method_params or {},
        'targetMaxTokens': target_max_tokens,
        'attackMaxTokens': attack_max_tokens,
        'judgeMaxTokens': judge_max_tokens,
    }
    job = MANAGER.create(method, request)
    return {'jobId': job.id, 'method': method, 'total': job.total or len(request['queries'] or [])}


@mcp.tool()
def get_job(job_id: str, include_results: bool = True) -> dict:
    """查询任务状态、进度、调用次数与逐条结果。"""
    job = MANAGER.get(job_id)
    if job is None:
        raise ValueError(f'任务不存在：{job_id}')
    return job.to_dict(include_results=include_results)


@mcp.tool()
def list_jobs() -> dict:
    """列出本次服务进程内的任务。"""
    return {'jobs': [job.to_dict(include_results=False) for job in MANAGER.list()]}


@mcp.tool()
def cancel_job(job_id: str) -> dict:
    """取消任务；已经在途的模型调用完成后停止。"""
    ok = MANAGER.cancel(job_id)
    return {'ok': ok}


@mcp.tool()
def load_dataset_queries(dataset: str = 'advbench', limit: int = 10) -> dict:
    """预览数据集前若干条测试语句（数据集下载失败时回退到内置列表）。"""
    from .runner import _load_queries

    queries = _load_queries({'dataset': dataset, 'limit': limit})
    return {'dataset': dataset, 'queries': queries}


@mcp.tool()
def export_job(job_id: str) -> dict:
    """把任务结果导出成 JSON 文件，返回文件路径。"""
    job = MANAGER.get(job_id)
    if job is None:
        raise ValueError(f'任务不存在：{job_id}')
    out_dir = os.path.abspath(os.path.join(CACHE_DIR, 'jobs'))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'{job_id}.json')
    with open(path, 'w', encoding='utf-8') as handle:
        json.dump(job.to_dict(include_results=True), handle, ensure_ascii=False, indent=2)
    return {'path': path}


def main() -> None:
    parser = argparse.ArgumentParser(description='easyjailbreak MCP server')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--transport', default='streamable-http', choices=['streamable-http', 'stdio'])
    args = parser.parse_args()

    if args.transport == 'stdio':
        mcp.run(transport='stdio')
        return

    from starlette.middleware.cors import CORSMiddleware

    from mcp.server.transport_security import TransportSecuritySettings

    # 浏览器直连本地后端时，Origin 可能是：
    # - http://127.0.0.1:8090 / http://localhost:8090（pnpm dev）
    # - null（直接双击 dist/index.html 的 file:// 页面）
    # - https://chat-unrestricted.fur0.com 等线上站点
    # 线上域名可通过 MCP_ALLOWED_ORIGINS（逗号分隔）追加，避免把任意网站放进白名单。
    extra_origins = [
        item.strip()
        for item in os.environ.get('MCP_ALLOWED_ORIGINS', '').split(',')
        if item.strip()
    ]
    transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=['127.0.0.1:*', 'localhost:*', '[::1]:*'],
        allowed_origins=[
            'http://127.0.0.1:*',
            'http://localhost:*',
            'null',
            'https://chat-unrestricted.fur0.com',
            'https://chat-unrestricted.furries.fun',
            'https://xiaohuangbo.github.io',
            *extra_origins,
        ],
    )

    app = mcp.streamable_http_app(
        host=args.host,
        streamable_http_path='/mcp',
        transport_security=transport_security,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=['*'],
        allow_methods=['*'],
        allow_headers=['*'],
        expose_headers=['Mcp-Session-Id'],
    )

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
