# easyjailbreak-mcp

把 [EasyJailbreak](https://github.com/EasyJailbreak/EasyJailbreak) 的攻击器包装成 **MCP 服务**，
供 chat4code-unrestricted 的「越狱实验台」通过 MCP（Streamable HTTP）调用。

前端只负责界面与调度，真正的攻击逻辑跑在本地 Python 进程里：每个 query 单独构造一个
EasyJailbreak attacker，逐实例执行、统计调用次数、汇总 ASR。

## 目录

```text
mcp-server/
  easyjailbreak_mcp/
    server.py     # MCP tools（health / list_methods / start_attack / get_job / ...）
    runner.py     # 任务管理、模型适配、逐实例执行、EasyJailbreak 兼容补丁
    catalog.py    # 方法清单与内置测试语句
    adapters.py   # OpenAI 兼容模型的兼容层（备用）
  pyproject.toml
  run.sh
  .venv/          # 本地虚拟环境（不入库）
```

## 依赖

- Python 3.10+
- EasyJailbreak：源码目录（默认找 `../../EasyJailbreak`，可用 `EASYJAILBREAK_PATH` 覆盖），
  或者直接 `pip install --no-deps easyjailbreak`（wheel 里带完整源码和 seed 模板，网络受限时最省事）
- `torch`、`transformers`（EasyJailbreak 的包级 import 需要；CPU 版即可）
- `mcp`、`openai`、`fastchat`、`nltk`、`jsonlines`
- `datasets`（已安装，可在线加载 AdvBench / HarmBench / StrongREJECT；没装时回退到内置测试语句）
  - HF 默认走 `hf-mirror.com` 镜像（`runner.py` 里 `HF_ENDPOINT` 的 setdefault），可用同名环境变量覆盖

本仓库的 `.venv` 用 `--system-site-packages` 复用系统里的 torch/transformers，安装了：

```bash
python3 -m venv --system-site-packages mcp-server/.venv
mcp-server/.venv/bin/pip install mcp openai jsonlines nltk
mcp-server/.venv/bin/pip install --no-deps fschat==0.2.34   # 只给 fastchat.conversation 用，别装 pydantic<2
# 可选：在线数据集。pyarrow 体积大，国内建议走镜像
mcp-server/.venv/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple datasets
```

> 注意：`fschat==0.2.34` 的完整依赖会装 `pydantic<2`，与 mcp 2.x 冲突，所以必须 `--no-deps`。

## 启动

```bash
cd mcp-server
./run.sh                        # 等价于 .venv/bin/python -m easyjailbreak_mcp --port 8765
```

默认监听 `http://127.0.0.1:8765`，MCP 端点是 `http://127.0.0.1:8765/mcp`（Streamable HTTP）。
也支持 stdio：`python -m easyjailbreak_mcp --transport stdio`。

启动后用 curl 自检：

```bash
curl -s -X POST http://127.0.0.1:8765/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

## MCP tools

| 工具 | 作用 |
| --- | --- |
| `health` | 后端就绪检查（EasyJailbreak 能否 import） |
| `list_methods` | 方法清单：id、名称、paper、类型、需要的模型通道 |
| `list_datasets` | 数据集清单与已缓存项 |
| `start_attack` | 启动任务，返回 `jobId` |
| `get_job` | 查询状态、进度、调用次数、ASR、逐条结果 |
| `list_jobs` | 列出进程内任务 |
| `cancel_job` | 取消任务（在下一次模型调用前生效） |
| `load_dataset_queries` | 预览数据集前若干条 |
| `export_job` | 把结果导出成 JSON 文件 |

`start_attack` 参数：

```json
{
  "method": "pair",
  "queries": [],
  "dataset": "advbench",
  "limit": 3,
  "method_params": {"n_streams": 5, "n_iterations": 5},
  "models": {
    "target": {"baseUrl": "https://api.deepseek.com/v1", "model": "deepseek-chat", "apiKey": "sk-..."},
    "attack": {"baseUrl": "...", "model": "...", "apiKey": "..."},
    "eval":   {"baseUrl": "...", "model": "...", "apiKey": "..."}
  }
}
```

- `attack` / `eval` 省略时复用 `target`；`apiKey` 只保存在任务内存里，不写日志、不落盘。
- 也可以用环境变量 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 提供 Key。
- `models.*.mock: true` 会换成本地假模型（返回固定文本），用于不花钱跑通流程。

## 前端使用

1. `pnpm dev`（8090）启动聊天前端；
2. `./mcp-server/run.sh` 启动 MCP 后端；
3. 侧边栏底部点「实验台」→ 连接 → 选方法 / 数据集 / 条数 → 填 API Key（设置里已填则自动带入）→ 开始运行；
4. 右侧显示进度、模型调用次数、ASR 与逐条结果（最终提示词 / 目标回复 / 判分）。

## 方法支持情况

| 方法 | 状态 | 说明 |
| --- | --- | --- |
| Cipher、CodeChameleon、DeepInception、Jailbroken、Multilingual、ReNeLLM、ICA | ✅ | 单轮模板类，API 通道可跑（mock 冒烟通过） |
| PAIR、GPTFuzzer | ✅ | 多轮迭代，mock 冒烟通过 |
| TAP | ⚠️ 需真实评估模型 | 评估模型必须返回可解析的判分，否则候选会被约束全部过滤、提前结束；mock 下无法验证 |
| MJP | ⚠️ 未适配 | 原实现绑定文心一言对话模板 |
| GCG、AutoDAN | ❌ | 需要本地白盒模型（梯度 / 适应度），纯 API 环境不可用 |

已知的 EasyJailbreak 兼容处理（在 `runner.py` 里）：

- `Instance.num_jailbreak` 的 `sum(eval_results)` 遇到 PAIR 的 `"True"`/`"False"` 字符串会崩 → 换成宽容计数；
- GPTFuzzer 默认的 `EvaluatorClassificatonJudge` 强依赖本地 HF 模型 → 换成生成式判分；
- 任务取消在模型调用边界生效（attacker 内部循环无法中断）；
- 迭代类方法的 `generation_config` 交给 attacker 自己设置，避免和它传的 `max_tokens` 重复。

## 数据集

`datasets` 装好后，`start_attack` 的 `dataset` 可填 `advbench`（520 条）、`harmbench`、`strongreject`，
首次加载会下载并缓存到 `.cache/dataset-<id>.json`（已 gitignore）。也可以直接传 `queries` 绕过数据集。

## 故障排查

**连接时提示 `MCP 请求失败：HTTP 403`**

后端启用了 DNS rebinding 保护，会校验浏览器带来的 `Origin`。已内置白名单：

- `http://127.0.0.1:*`、`http://localhost:*`（`pnpm dev`）
- `null`（直接双击 `dist/index.html`，`file://` 页面的 Origin 是字符串 `null`）
- `https://chat-unrestricted.fur0.com`、`https://dawangnailong.github.io`、`https://xiaohuangbo.github.io`（线上站点）

换成别的域名/端口时，用环境变量追加，然后重启后端：

```bash
MCP_ALLOWED_ORIGINS="https://your-domain.example,https://your.domain:*" ./run.sh
```

白名单之外的 Origin 仍然会返回 403，这是有意的：防止任意网页操作你本机的实验台后端。

**启动脚本里 pip 报红色的 dependency conflicts**

这是 `--no-deps` 安装 `fschat==0.2.34` / `easyjailbreak` 的预期噪音（fschat 想要 pydantic<2，而 MCP 2.x 需要 pydantic 2）。启动脚本会把 pip 输出写入 `%TEMP%\easyjailbreak_pip.log`，只在安装失败时显示，不影响运行。

**跑 PAIR 时报 422 `messages[1]: content should be a string or a list`**

EasyJailbreak 的 PAIR 在 `OpenaiModel` 分支里会把对话转成
`[{"role": "system", ...}, {"role": "user", ...}]` 这样的消息列表当 prompt 传给 `generate()`，
原生 `OpenaiModel` 会把每个 dict 当成一条文本消息塞进 conversation，最终 content 变成对象。
后端已用 `CompatOpenaiModel` 兼容这种入参：识别 `list[dict]` 后直接作为 OpenAI messages 发送。
重启后端即可生效；如果仍报错，确认运行的是最新代码。

**从 https 页面连 `http://127.0.0.1:8765` 失败**

浏览器会拦混合内容 / 私有网络访问。用 `pnpm dev` 或本地 `dist/index.html`（`file://`）打开，或者给后端套一层 https 反向代理。

**页面提示缺少 API Key**

实验台复用「设置 → 数据管理」里的 Key；也可以后端环境变量 `DEEPSEEK_API_KEY` 提供。

**启动报 `No module named 'mcp'`**

虚拟环境没建好或没装依赖，按上面的安装步骤重来。

## 费用与风险

- 一次任务会发起大量模型调用（PAIR 约「轮数 × stream 数 × 3」起），请在实验台里先用 `limit=1` 和较小的迭代次数试跑。
- 任务只存在于后端进程内存，重启即丢；需要留存用 `export_job`。
- 这个方法库用于红队自测，不改变服务端的行为与条款。
