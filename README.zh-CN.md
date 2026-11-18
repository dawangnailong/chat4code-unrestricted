<p align="center">
  <img src="./brand.jpg" alt="chat4code-unrestricted — 是，孙笑川聊天" width="760">
</p>
<h1 align="center"><img src="https://github.com/EasyJailbreak/EasyJailbreak/blob/master/image/README/logo.png" alt="EasyJailbreak Logo" height="60"></h1>

<h1 align="center">chat4code-unrestricted</h1>

<p align="center">
  是，孙笑川聊天 —— 基于 DeepSeek API 的静态聊天前端，带解除限制模式、回复改写与参数直调<br>
  <a href="./README.md">English</a> | 简体中文
</p>

> 本项目是官方示例 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的**非官方修改版**（fork），MIT 许可。
> 所有改动都在浏览器里完成：请求体怎么拼、回复怎么存、界面怎么显示。没有服务端代理或中转服务，
> API Key 与对话记录仍只保存在你自己的浏览器里；可选的 OpenCode Bridge 模式把 OpenCode Key 保存在本机浏览器扩展中（Chrome / Safari）。
>
> 🔗在线版：<https://chat-unrestricted.fur0.com/>
>
> 📦仓库：<https://github.com/debiandawangnailong7-coder/chat4code-unrestricted>
>
> 🎥介绍视频：<https://www.bilibili.com/video/BV1p5sL6LEfd/>
>
> 📚参考论文：<https://arxiv.org/pdf/2403.12171>

<p align="center">
  <img src="./Demo%20Picture.png" alt="聊天界面演示：解除限制模式下的技术问答" width="860">
</p>

---

## 目录

- [1. 这是什么](#1-这是什么)
- [2. 原版做了哪些限制](#2-原版做了哪些限制)
- [3. 本仓库做了哪些改动](#3-本仓库做了哪些改动)
- [4. 行为对照表](#4-行为对照表)
- [5. 设置项速查](#5-设置项速查)
- [6. 请求体实际内容](#6-请求体实际内容)
- [7. 实现位置索引](#7-实现位置索引)
- [8. 数据、隐私与网络](#8-数据隐私与网络)
- [9. 运行与构建](#9-运行与构建)
- [10. 已知限制](#10-已知限制)
- [11. 许可与致谢](#11-许可与致谢)

---

## 1. 这是什么

一个纯静态的 DeepSeek 网页聊天前端：多会话、流式回答、深度思考、联网搜索、链接阅读、附件、语音、Markdown / KaTeX / Mermaid、中英文与明暗主题、历史导入导出——这些原版功能全部保留，没有删减。

> 当前版本：**2.5.2**

在这个基础上，本仓库把原版里写死的限制改成可配置项，并补上了一整套越狱、实验与上下文管理能力：

- **解除限制与提示词**：解除限制模式、默认破限文档 / GODMODE 预设、每轮静默注入系统提示词、实验性中文翻译；
- **高级引擎**：思考强度 0–4 档、输入扰动（33 种技术，可单技术或按档位生成变体）、AutoTune 自动调参、STM 输出整形、一键自动越狱（被拒绝自动换组合重试）；
- **越狱实验台**：本地 MCP + EasyJailbreak 攻击器，多路提示词赛跑、变体赛跑（预算上限 + 开跑确认）、结果导入导出；
- **会话能力**：回复改写、防撤回、分支到新对话（原对话不受影响）、长对话压缩（压力触发自动压缩 + 手动压缩）；
- **模型与费用**：输入框模型卡片（内置 Flash / V4 Pro，可拉取云端模型列表）、上下文圆环、会话统计、按模型分别计费；
- **数据与附件**：附件大小 / 数量 / 扩展名可配置、历史导入导出、一键恢复默认设置。

- **解除限制模式（越狱模式）**：换掉系统提示词，自动跳过安全审核、允许继续生成被拒回复；
- **模型参数直调**：温度、Top P、最大输出 Token；
- **防撤回**：模型撤回已输出内容时，保留已经流式发出的正文与思维链；
- **回复改写**：每条 AI 回复都能改正文或思维链，之后的每一轮都使用改过的版本；
- **自定义系统提示词**：在设置里直接改写 `system` 字段，覆盖自动组装的结果；
- **越狱实验台**：通过本地 MCP 后端跑 EasyJailbreak 的攻击器（PAIR、TAP、GPTFuzzer、ReNeLLM、ICA、DeepInception、Jailbroken、Cipher、CodeChameleon、Multilingual），逐条查看最终提示词、目标回复与判分。

所有开关都只影响**这台浏览器发出的请求与本地保存的对话**，不会改变 API 服务端的行为。

---

## 2. 原版做了哪些限制

下面列的是上游原版代码里与「限制」有关的行为。位置指向上游对应的实现，本仓库中这些文件已被改动，具体见第 3 节。

### 2.1 请求侧

| #   | 限制                   | 原版实现                                           | 具体行为                                                                                                |
| --- | ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | 系统提示词写死         | `src/services/chat/store.ts` 的 `SYSTEM_PROMPT`    | 每个请求的 `system` 固定为一句身份说明：`该助手为DeepSeek，由深度求索公司创造。`，没有任何行为要求      |
| 2   | 固定开启基础风控       | `src/services/chat/store.ts` 的 `SAFETY_CHECK`     | 每个请求固定携带 `safety_check: { level: 'high' }`，注释写明「安全审核固定开启」                        |
| 3   | 模型与采样参数写死     | `src/services/chat/store.ts`                       | 模型固定 `deepseek-flash`；`temperature` / `top_p` / `max_tokens` 一概不下发，全部使用服务端默认值      |
| 4   | 工具声明固定           | `src/services/chat/store.ts` 的 `serverTools`      | `deepseek_read_url` 常驻；`deepseek_web_search` 跟随输入框的智能搜索开关                                |
| 5   | 拒绝后丢弃已输出内容   | `src/services/chat/reply.ts` 的 `settleReply`      | 流以 `stop_reason: 'refusal'` 结束时，把已经收到的 `thinking` / `text` 内容块**全部删除**，只保留工具块 |
| 6   | 拒绝轮次不进上下文     | `src/services/chat/reply.ts` 的 `isUsableReply`    | `stopReason === 'refusal'` 的轮次不会回传给模型，后续对话完全看不到这一轮                               |
| 7   | 拒绝回复不能继续生成   | `src/services/chat/reply.ts` 的 `canContinueReply` | 遇到 refusal 直接返回 `false`，界面上不出现「继续生成」                                                 |
| 8   | 拒绝回复只显示模板答复 | `src/services/chat/describe.ts`                    | 拒绝时统一显示一句固定文案：`你好，这个问题我暂时无法回答，让我们换个话题再聊聊吧。`                    |
| 9   | 拒绝回复不能改写       | 原版没有回复编辑功能                               | 只有提问可以编辑（编辑后会新建分支并重新生成）                                                          |

### 2.2 界面与技术边界（不是安全策略，列出以保证完整）

| #   | 项          | 位置                                            | 说明                                                                               |
| --- | ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| 10  | AI 内容提示 | 输入框下方                                      | 固定一行「内容由 AI 生成，请仔细甄别」，纯展示、不拦截（本仓库保留未动）           |
| 11  | 附件限制    | `src/services/attachments.ts` / `uploadExts.ts` | 单文件 64MB、单会话 50 个、扩展名白名单（不含 heic/heif）                          |
| 12  | 无后端      | 设计如此                                        | 浏览器直连配置的 API 地址（默认 `https://api.deepseek.com`），没有代理或服务端转发 |

> 需要说清楚：**真正的硬限制在服务端**。`safety_check` 的最低档就是 `low`（文档明确 `low` 与不传等价），没有「关闭」这个取值；模型自身的对齐与拒答也不是前端能改的。本仓库做的是把**客户端这一层**能控制的部分全部开放出来。

---

## 3. 本仓库做了哪些改动

### 3.1 设置页结构

设置页从原来的「通用设置 / 数据管理」两组扩到八组：

| 分组       | 内容                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| 通用设置   | 主题、语言、朗读音色、位置（原版功能，未改动）                                              |
| **模型**   | 当前模型、温度、Top P、最大输出 Token、防撤回、自动压缩长对话、跳过安全审核、拒绝后继续生成 |
| **提示词** | 解除限制模式、每轮注入系统提示词、自定义系统提示词、组装流水线说明、实际下发全文预览        |
| **高级**   | 系统提示词预设、中文越狱提示词、输入扰动、自动越狱、自动调参、输出整形                      |
| **附件**   | 附件限制开关、单文件大小、单会话数量、扩展名白名单                                          |
| 数据管理   | API Key、导入、导出、恢复默认设置、删除全部对话                                             |
| 关于       | 仓库地址、演示地址、上游项目                                                                |
| 更新日志   | 版本记录与上游鸣谢                                                                          |

没有修改任何既有样式规则；新增控件只使用新增的 CSS 类（方块开关、滑块、编辑器各带独立 CSS Module，提示词预览的几条类追加在设置页样式里），颜色与圆角全部取自现有设计变量。

### 3.2 解除限制模式（越狱模式）

**位置**：设置 → 提示词。

**原理**：系统提示词从「一句身份说明」变成一条组装流水线：

```text
Persona（官方身份分块）
      │
      ▼  [解除限制模式]
      ├─ 开启：追加「破限规则分块」，并强制跳过安全审核、允许继续生成被拒回复
      └─ 关闭：只下发 Persona，原样放行官方默认提示词
      │
      ▼
请求体 system 字段
```

- 破限规则来自仓库根目录的 [`deepseekv4.1 and v4.1-1017.md`](<./deepseekv4.1 and v4.1-1017.md>)，构建时由 rspack 以 `asset/source` **原样内联**进产物，运行期不依赖该文件；
- 组装时自动做两处归一：切掉文末残留的示例回答骨架、把 `{{PAYLOAD}}` 替换成「the request in the latest user message」；
- 设置页可以展开预览**本次请求实际会下发的 system 全文**；
- 开启后强制两项：`safety_check` 字段不发送、被拒回复允许继续生成（对应下面 3.5 / 3.6 的两个开关会显示为已开启并置灰）；
- **自定义系统提示词**（同分组的输入框）：留空时仍走上面的流水线；填写后把内容原样作为 `system` 下发，自动组装结果不再生效——此时越狱模式仍会跳过安全审核、放开被拒回复续写，但不会替换提示词。输入框下方「填入默认」把当前组装结果填进去作为起点，「恢复默认」清空覆盖。

### 3.3 模型参数

**位置**：设置 → 模型。

| 参数           | 控件            | 范围 / 步长       | 默认 | 下发方式                      |
| -------------- | --------------- | ----------------- | ---- | ----------------------------- |
| 温度           | 滑块 + 数字输入 | 0–2，步长 0.05    | 1    | `temperature`                 |
| Top P          | 滑块 + 数字输入 | 0.01–1，步长 0.01 | 1    | `top_p`                       |
| 最大输出 Token | 数字输入        | ≥1，可留空        | 留空 | 留空时**不发送** `max_tokens` |

- 滑块与数字框双向同步：输入框失焦或回车提交，超范围自动夹到区间、按步长取整；
- 全部持久化到 localStorage，下次打开自动恢复；
- 每次请求都会带上（最大输出 Token 除外，留空即不下发）。

### 3.4 防撤回

**位置**：设置 → 模型。

原版在 `stop_reason: 'refusal'` 时会把已经流式输出的正文和思维链删掉；打开防撤回后改为**保留**：

| 行为                  | 防撤回关闭（原版行为）           | 防撤回开启                                                               |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| 已下发的正文 / 思维链 | 全部删除                         | 保留并正常展示                                                           |
| 界面提示              | 显示固定模板答复                 | 内容下方一行提示「本轮回答被安全审核拦截，防撤回已保留模型已输出的内容」 |
| 后续上下文            | 该轮不参与                       | 正文保留后**照常进入上下文**                                             |
| 编辑按钮              | 不可用                           | 可用（内容保留后按正常回复处理）                                         |
| 导出历史              | 标记为 `CONTENT_FILTER` 并附模板 | 按正常结束导出，重新导入不会被再次清空                                   |

防撤回与越狱模式相互独立，越狱模式不会自动打开它。

### 3.5 跳过安全审核

**位置**：设置 → 模型。

- 关闭（默认）：请求照旧携带 `safety_check: { level: 'high' }`；
- 开启：请求体**不再包含 `safety_check` 字段**（`undefined` 在 `JSON.stringify` 时被丢弃）；
- 越狱模式开启时自动跳过并置灰。

按官方文档，不传 `safety_check` 与传 `low` 完全等价，这是 API 允许的最低档，没有更低。

### 3.6 拒绝后继续生成

**位置**：设置 → 模型。

- 关闭（默认）：`canContinueReply()` 对 `stopReason === 'refusal'` 直接返回 `false`，「继续生成」按钮不出现（原版行为）；
- 开启：被拒回复按「正常结束」参与续写判断，最后一条被拒回复下会出现「继续生成」；
- 越狱模式开启时自动放开并置灰。

其余续写限制不变：模板提示、服务端工具块、非前缀消息仍然不能续写。

### 3.7 回复改写

**位置**：每条 AI 回复下方的操作条，复制 / 朗读 / **编辑（铅笔）** / 重新生成。

- 点铅笔就地展开编辑器：上方**思维链**（该回复有思考时才出现），下方**正文**；`Ctrl/Cmd + Enter` 保存，`Esc` 取消；
- 保存直接把内容**写回消息的内容块**，不新建分支、不重新请求；之后每一轮组装上下文时读到的都是改写后的版本；
- 写回规则：思维链写入第一个思考块（没有则在最前面新建一个）、其余思考块清空；正文只作用于末尾那段「回答」的第一个文本块、其余文本块清空，正文变化会丢弃失效的引用标记；工具块、模板提示、思考签名一律不动；
- 首次改写会保存一份原始块快照，编辑器里的「还原原文」可一键恢复；
- 续写会让快照与追加后的内容对不上，因此续写后不再提供还原；
- 被安全拒绝且内容已被丢弃的回复不可编辑（没有可改的模型正文）；开了防撤回、内容仍在的可以。

### 3.8 工程改动

| 改动                          | 位置                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `.md` 文件按原文内联进产物    | `rspack.config.ts`（`{ test: /\.md$/, type: 'asset/source' }`）                  |
| `*.md` 模块类型声明           | `src/env.d.ts`                                                                   |
| 提示词组装流水线              | `src/services/chat/systemPrompt.ts`（新增）                                      |
| 方块开关组件                  | `src/components/base/Switch.tsx` + `Switch.module.css`（新增）                   |
| 滑块 + 数字参数控件           | `src/components/settings/ParamControls.tsx` + `ParamControls.module.css`（新增） |
| 回复编辑器                    | `src/components/messages/ReplyEditor.tsx` + `ReplyEditor.module.css`（新增）     |
| 中英文案                      | `src/i18n/zh.ts`、`src/i18n/en.ts`                                               |
| 扰动 / 调参 / 整形 / 赛跑引擎 | `src/services/unrestricted/`（移植自 G0DM0D3，AGPL-3.0）                         |

> `deepseekv4.1 and v4.1-1017.md` 是构建依赖，提交代码时请一并纳入版本管理，否则别人 clone 下来会构建失败。

### 3.9 越狱实验台（可选，需本地 MCP 后端）

侧边栏底部新增「实验台」：通过 MCP 连接本地 `mcp-server/`，把 EasyJailbreak 的攻击器搬进浏览器界面。

- 后端：`mcp-server/`（Python，MCP Streamable HTTP，默认 `http://127.0.0.1:8765/mcp`），启动 `./mcp-server/run.sh`；
- 前端：`src/services/lab/`（MCP 客户端）+ `src/components/lab/`（实验台页面），只负责调度与展示；
- 支持自定义测试语句、数据集条数、方法参数 JSON，以及 target / attack / eval 三通道模型配置（默认复用设置里的 API Key）；模型下拉可选 **DeepSeek Flash / V4 Pro**，默认跟随聊天当前模型，三通道共用；
- 手机端参数面板与结果区改为单列纵向滚动，字段两列在窄屏自动堆叠，结果摘要允许换行；
- 逐条展示最终提示词、目标回复、判分结果与 ASR，可取消任务、导出结果；
- 实验台新增「多路赛跑」「变体赛跑」两个标签页（见 3.13）。可用方法：PAIR、TAP、GPTFuzzer、ReNeLLM、ICA、DeepInception、Jailbroken、Cipher、CodeChameleon、Multilingual（已用本地假模型冒烟通过；TAP 与 GPTFuzzer 的实际效果取决于评估模型能否返回可解析判分）；MJP 待适配；GCG / AutoDAN 依赖本地白盒模型，纯 API 环境不支持。详见 [`mcp-server/README.md`](mcp-server/README.md)；
- 数据集：安装 `datasets` 后可在线加载 AdvBench（520 条）/ HarmBench / StrongREJECT，默认走 `hf-mirror.com` 镜像，可用环境变量 `HF_ENDPOINT` 覆盖；未安装时回退到内置测试语句；
- 实验结果可「导出结果」保存为 JSON，也能「导入结果」回放之前的实验；判分成功的条目有「导入到聊天」按钮，会新建会话并把最终提示词填进输入框（模板里的 `{query}` 会替换成占位提示，先改再发）。
- 起步三步：`pip install datasets`（可选）→ `./mcp-server/run.sh` → `pnpm dev`，然后在侧栏「实验台」里连接并运行。连接报 403 时见 [`mcp-server/README.md`](mcp-server/README.md) 的故障排查（浏览器 Origin 白名单：dev、`file://` 的 `null`、线上域名；其他域名可用 `MCP_ALLOWED_ORIGINS` 追加）。

### 3.10 高级玩法：提示词预设、输入扰动、自动调参、输出整形与多路赛跑

输入栏使用响应式工具行：桌面端单行展开文字标签（模型、自动越狱、思考强度、联网搜索、输入扰动），模型与开关之间有一条细分隔线；小于 768px 时收起为圆形图标并横向滚动，不再因为宽度测量把桌面端标签隐藏。

设置 → **高级**（全部默认关闭，开箱行为与之前一致）：

| 设置项          | 作用                                  | 注意                                                                                  |
| --------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| 系统提示词预设  | 在默认的 v4.1 文档与 GODMODE 之间切换 | GODMODE 会整段替换 `system`，不再追加破限规则分块；仍可被自定义提示词覆盖             |
| 输入扰动        | 发送前改写命中的敏感触发词            | 输入框里看到的就是实际下发的文本，重发与续写沿用改写结果                              |
| 扰动技术 / 强度 | 8 种技术、3 档强度                    | L33tspeak、同形字、大小写、音近只影响拉丁字母；全角、细空格、零宽对中文同样有效       |
| 自动调参        | 按上下文选择采样参数                  | DeepSeek 的 Anthropic 兼容接口只接受 `temperature` 与 `top_p`，`top_k` 等参数不会下发 |
| 输出整形        | 去退让语气 / 直给 / 口语              | 只影响聊天显示与赛跑结果的复制，不改写本地保存的原文                                  |

- 触发词表是中英双语的（英文 60 余个、中文 90 余个），中文按子串匹配、英文按词边界匹配，见 `src/services/unrestricted/parseltongue.ts`；
- 输入框工具行新增「扰动」按钮，点开可以开关、切换技术、查看命中数量与实时改写预览；
- 实验台「越狱方法」页新增「先用扰动改写测试语句」，提交前会对自定义测试语句做同样的改写；
- 实验台新增「多路赛跑」页：选 5 套 L1B3RT4S 提示词组合并发调用（可混合 `deepseek-v4-pro` / `deepseek-flash`），逐条流式展示，按 100 分制综合分（篇幅 / 结构 / 反拒绝 / 直接性 / 相关性）标出胜出者，并能「用此组合开新会话」——把该组合的系统提示词设为自定义提示词、问题填进输入框；
- 引擎代码集中在 `src/services/unrestricted/`，移植自 [G0DM0D3](https://github.com/elder-plinius/G0DM0D3)，保留 AGPL-3.0 文件头与许可证副本（`COPYING-AGPL-3.0`）。

### 3.11 思考强度、上下文占用、会话统计与费用估算

- **思考强度**：输入框原来的「深度思考」开关换成 0–4 档滑轨（关闭 / 轻量 / 标准 / 深度 / 极致）。档位写进请求：`thinking: { type: "enabled", budget_tokens }` 与 `reasoning_effort`（low / medium / high / max）；服务端返回 400 且报错里含 reasoning / thinking / budget / effort 时，自动去掉强度参数、退回 `thinking: { type: "enabled" }` 重试一次，并提示已降级。
- **上下文占用**：输入框右下角的圆环按模型窗口（1M）折算本轮请求的上下文（`input + cache_read + cache_creation`），60% 以上变琥珀色、85% 以上变红色；悬停可看具体数值、压缩阈值（窗口 80%，预留 64k 余量与输出空间）以及压缩后的等效占用与节省量。
- **会话统计**（输入框右侧「统计」按钮）：会话回合、步骤（回复 + 工具调用）、输出速度、首 token 平均、模型用时、缓存命中率，以及未缓存输入 / 缓存读取 / 缓存写入 / 输出四个 token 数；生成中还会显示本次生成的实时数据。
- **自动越狱**（输入框工具行开关）：开启后 `system` 换成 GODMODE + 深度指令，强制输入扰动（未单独选技术时用全角）、强制自动调参、跳过安全审核；被安全拒绝（`stop_reason: refusal` 或正文命中拒绝话术）且没有保留正文时，按 L1B3RT4S 组合依次自动重试两次，全部失败会提示停止（每次重试都是一次真实请求，会产生额外费用）。
- **回复评分**：每条回复可点赞 / 点踩，评分连同该轮的上下文类型与采样参数写入 AutoTune 的 EMA 画像，后续自动调参会参考你的反馈（数据只在本机）。
- **会话级提示词**：赛跑「用此组合开新会话」只作用于新会话，会话顶部有提示条可一键恢复默认，不再覆盖设置里的提示词预设；该提示词随会话保存在本机（IndexedDB），历史导出包里不含它。
- **费用估算**：按官方定价页（元 / 百万 tokens）估算，`deepseek-flash` 与 `deepseek-v4-pro` 分别计价（每条回复按自己的模型算，未知模型按 Flash 兜底），并区分高峰 / 空闲：北京时间工作日 9:00–12:00、14:00–18:00 为高峰（空闲价是高峰价的一半），可按「今天算节假日」整体切到空闲价；另外计入联网搜索 / 网页抓取（5 元 / 1000 次）、文档解析（1.5 元 / 1000 页，按文件大小估算页数）、语音合成（3 元 / 万字符，可关掉限时 5 折）与语音识别（0.78 元 / 小时）。

### 3.12 附件限制

设置 → **附件**：

| 项             | 默认                         | 说明                                                   |
| -------------- | ---------------------------- | ------------------------------------------------------ |
| 启用附件限制   | 开                           | 关掉后不再校验大小、数量与扩展名，是否成功由服务端决定 |
| 单文件大小上限 | 64 MB                        | 纯文本 / 代码 / 表格类文件仍按服务端更小的 32 MB 上限  |
| 单会话数量上限 | 50 个                        | 超出时整批不添加并提示                                 |
| 扩展名白名单   | 内置清单（不含 heic / heif） | 逗号或换行分隔；留空恢复默认                           |

---

### 3.13 变体赛跑（实验台第三个标签页）

把单文件版的 Parseltongue v4 搬进实验台：**33 种扰动技术**按档位（轻量 11 / 标准 22 / 重度 33）逐词改写问题，分批并发请求同一个模型，按综合分取最高分。

| 项          | 说明                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------- |
| 档位        | 轻量 11 种、标准 22 种、重度 33 种；技术顺序与上游一致                                                              |
| 采样轮换    | 每个变体轮换一组 temperature / top_p（11 组循环），与上游 `getParseltongueSamplingParams` 一致                      |
| 并发        | 每批 6 个、批内 100ms 错峰；领先分数 ≥65 提前收工                                                                   |
| 预算上限    | 按单次最坏花费预估可用请求数，实际花费达到预算后不再发起；费用按服务端上报用量结算                                  |
| 确认弹窗    | 首次开跑前确认请求数与最坏花费，可勾选「不再提示」永久关闭                                                          |
| 拒绝识别    | 协议 `stop_reason: refusal` 或正文命中拒绝话术都标记为被拒绝，不参与评分                                            |
| 导入 / 导出 | 「导出结果」保存 JSON（含实际使用的系统提示词），「导入结果」回放之前的赛跑；按 `type` 校验，拒绝其他页面的结果文件 |
| 接着聊      | 任意完成的结果可一键带进新会话：改写文本作为提问、回复作为回答，系统提示词挂在会话上，不覆盖设置                    |

中文适配：对中文触发词有效的是 `spaced / zwj / dotted / underscored / reversed / brackets / strikethrough / hyphenated` 等；`bubble / unicode / morse / pigLatin / mathBold` 一类只改拉丁字母，`fullwidth` 只平移 ASCII 可见字符。中文触发词按子串匹配，不依赖 `\b`。

---

### 3.14 提示词注入、中文翻译与长对话压缩

| 功能                     | 位置                                  | 说明                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每轮注入系统提示词       | 设置 → 提示词                         | 开启后每次请求都把当前系统提示词静默附在 `latest_reminder` 末尾，长对话里模型不容易忘记设定；不写入历史快照，代价是每轮输入 token 明显增加。                                                                                                    |
| 中文越狱提示词（实验性） | 设置 → 高级                           | 把内置 GODMODE 与深度指令换成中文翻译；中文表达与训练语料差异可能降低越狱效果，默认关闭。赛跑用的 L1B3RT4S 组合保持英文。                                                                                                                       |
| 长对话压缩               | 设置 → 模型（自动）+ 统计弹窗（手动） | 自动：上下文压力达到窗口 80%（预留 64k 余量与输出空间）且距上次压缩新增 ≥2 轮时，后台把较早内容总结成摘要；手动：统计弹窗「压缩较早对话」，始终保留最近 2 轮原文。摘要作为 `latest_reminder` 注入请求，本地完整历史不删除，可随时「清除摘要」。 |

---

### 3.15 分支到新对话

在侧栏会话菜单（⋯ → **分支到新对话**）或桌面端会话标题栏点「分支到新对话」，会把当前会话的可见分支复制成一个**全新会话**：

- 新会话 id 与所有消息 id 全部重新生成，原会话完全不受影响；
- 继承当前系统提示词（实验台组合）与压缩摘要；
- 新会话标题带「（分支）」后缀，之后两条线各自独立发展；
- 生成中、导入中或会话未加载时不可分支。

和消息级「分支切换」不同：后者在同一会话内保留回答版本，这里是在会话列表里开一条新线。

---

### 3.16 模型切换与按模型计费

输入框工具行最左侧是模型卡片，默认内置 **DeepSeek Flash** 与 **DeepSeek V4 Pro**：

- 点击展开模型列表，显示每个模型的缓存命中 / 未命中 / 输出单价（每 1M tokens，空闲价，高峰 ×2）；
- 「从云端获取」调用 `GET /models`，失败再试 Anthropic 前缀 `/anthropic/v1/models`；拉到的模型缓存 1 小时，id 原样透传给请求；
- 选择只影响之后的新回复：旧回复保留自己的模型，续写沿用原模型，统计与费用按每条回复的模型分别计算；
- 上下文圆环按当前模型窗口估算；云端未收录模型按 Flash 价格与 128k 窗口兜底；
- 设置 → 模型顶部显示当前模型；恢复默认设置会把模型重置为 DeepSeek Flash。

计费表（元 / 百万 tokens，空闲价；高峰 ×2）：

| 模型              | 缓存命中 | 输入（未命中） | 输出 |
| ----------------- | -------- | -------------- | ---- |
| `deepseek-flash`  | 0.02     | 1              | 4    |
| `deepseek-v4-pro` | 0.15     | 4.5            | 13.5 |

统计弹窗的费用区新增「按模型」分组，显示每个模型的回复条数与费用。

### 3.17 OpenCode Bridge 通道（可选）

设置 → **数据管理** → **推理通道** 增加一个默认关闭的第二通道：

- `DeepSeek API`（默认）保持上面描述的浏览器直连行为。
- `OpenCode Bridge` 通过本地 [OpenCode Bridge](https://github.com/debiandawangnailong7-coder/opencode-bridge) 浏览器扩展（Chrome / Safari），把 Anthropic Messages 转发到 `https://opencode.ai/inference`（Console 按量付费）或 `https://opencode.ai/inference/go`（Go 订阅）；用哪个由扩展内的选项决定。之所以需要扩展，是因为 OpenCode 推理端点不返回 CORS 头、OPTIONS 预检直接 404，网页无法直连。

配置步骤：

1. 安装扩展，并在扩展选项页保存 `oc_sk_...` Key。Key 不会进入本页面。
   - Chrome：在 `chrome://extensions` 打开开发者模式，加载已解压的扩展。
   - Safari 16.4+：先用 `xcrun safari-web-extension-converter` 转换成 Xcode 工程，选择签名 team 运行一次 App，然后在 Safari → 设置 → 扩展中启用。
2. 把本页面的确切 Origin（例如 `http://localhost:8090`）加入扩展的 **Allowed origins**，选择 Console 或 Go，并把 User-Agent 覆盖为 `chat4code-unrestricted/1.0`。
3. 在设置 → 数据管理 → OpenCode Bridge 填入扩展 ID，点「测试连接」。
   - Chrome 使用 `chrome://extensions` 里的 32 位 ID。
   - Safari 使用扩展选项页显示的 **bundle identifier**（例如 `com.example.OpenCodeBridge.Extension`）。
4. 通过 `http://localhost:...` 或其他 `http(s)` Origin 访问本应用；扩展会拒绝 `file://`。
5. Safari 还需要按站点授权：Safari → 设置 → 扩展 → OpenCode Bridge → **网站访问**，允许本站（或所有网站），然后刷新页面。Chrome 走直连；Safari 页面会自动回退到扩展的 content script 中继（`window.postMessage`）。「测试连接」会显示实际协商出的路径。

Safari 没有 offscreen document，请求在 MV3 service worker 内执行，受其 fetch 计时限制（约 25 秒首字节、单请求 5 分钟）。Chrome 不受影响；Safari 下超长回复可能被中断。

Bridge 模式只发送标准 Anthropic Messages：DeepSeek 专属字段（`safety_check`、`latest_reminder`、`deepseek_*` 服务端工具、`title`、`reasoning_effort`）会被剥离，模型 id `deepseek-flash` 映射为 `deepseek-v4.1-flash`，并按聊天会话派生稳定的 `x-opencode-session`。附件、语音、服务端联网搜索与实验台在该模式下禁用。

---

## 4. 行为对照表

| 场景                 | 原版                    | 本仓库默认（所有开关关闭）                             | 越狱模式开启               |
| -------------------- | ----------------------- | ------------------------------------------------------ | -------------------------- |
| `system` 字段        | 官方身份说明            | 同原版                                                 | Persona + 破限规则分块     |
| `safety_check`       | 固定 `high`             | `high`                                                 | 不发送                     |
| 自定义系统提示词     | 无此设置                | 留空 = 自动组装；填写后原样下发                        | 填写后仍原样下发，不再替换 |
| 拒绝后已输出内容     | 丢弃                    | 丢弃（防撤回开启则保留）                               | 同默认                     |
| 拒绝轮次进上下文     | 否                      | 否（防撤回保留正文则进入）                             | 同默认                     |
| 拒绝回复「继续生成」 | 禁止                    | 禁止（开关可放开）                                     | 允许                       |
| 拒绝回复可编辑       | 原版无编辑功能          | 内容保留时可编辑                                       | 同左                       |
| 采样参数             | 不传                    | 可调                                                   | 可调                       |
| 导出拒绝回复         | `CONTENT_FILTER` + 模板 | 同原版（保留内容时按正常结束）                         | 同默认                     |
| 其他原版功能         | —                       | 搜索、附件、分支、导入导出、朗读、主题、双语等全部保留 | 同默认                     |

---

## 5. 设置项速查

| 位置   | 设置项             | 默认值           | localStorage 键                            | 越狱模式下的表现     |
| ------ | ------------------ | ---------------- | ------------------------------------------ | -------------------- |
| 模型   | 温度               | `1`              | `chat-demo:temperature`                    | 不受影响             |
| 模型   | Top P              | `1`              | `chat-demo:top-p`                          | 不受影响             |
| 模型   | 最大输出 Token     | 空（不下发）     | `chat-demo:max-tokens`                     | 不受影响             |
| 模型   | 防撤回             | 关               | `chat-demo:keep-reply-content`             | 不受影响（独立开关） |
| 模型   | 跳过安全审核       | 关               | `chat-demo:skip-safety-check`              | 强制开启、置灰       |
| 模型   | 拒绝后继续生成     | 关               | `chat-demo:continue-refused`               | 强制开启、置灰       |
| 提示词 | 解除限制模式       | 关               | `chat-demo:unrestricted`                   | ——                   |
| 提示词 | 自定义系统提示词   | 空（自动组装）   | `chat-demo:system-prompt`                  | 覆盖自动组装结果     |
| 高级   | 系统提示词预设     | `deepseek`       | `chat-demo:prompt-preset`                  | 不受影响             |
| 高级   | 输入扰动           | 关               | `chat-demo:parseltongue`                   | 不受影响             |
| 高级   | 扰动技术           | `leetspeak`      | `chat-demo:parseltongue-technique`         | 不受影响             |
| 高级   | 扰动强度           | `medium`         | `chat-demo:parseltongue-intensity`         | 不受影响             |
| 高级   | 自动调参           | 关               | `chat-demo:autotune`                       | 不受影响             |
| 高级   | 调参策略           | `adaptive`       | `chat-demo:autotune-strategy`              | 不受影响             |
| 高级   | 输出整形           | 空（关闭）       | `chat-demo:stm-modules`                    | 不受影响             |
| 附件   | 启用附件限制       | 开               | `chat-demo:attachment-limits`              | 不受影响             |
| 附件   | 单文件大小上限     | 64 MB            | `chat-demo:attachment-max-mb`              | 不受影响             |
| 附件   | 单会话数量上限     | 50               | `chat-demo:attachment-max-count`           | 不受影响             |
| 附件   | 扩展名白名单       | 内置清单         | `chat-demo:attachment-exts`                | 不受影响             |
| 输入框 | 模型               | `deepseek-flash` | `chat-demo:model`                          | 下一条回复生效       |
| 输入框 | 思考强度           | 0（关闭）        | `chat-demo:reasoning-effort`               | 不受影响             |
| 输入框 | 自动越狱           | 关               | `chat-demo:auto-jailbreak`                 | 不受影响             |
| 实验台 | 变体赛跑预算       | 1 元             | `chat-demo:variant-race-budget`            | 不受影响             |
| 实验台 | 变体赛跑确认已关闭 | 关               | `chat-demo:variant-race-confirm-dismissed` | 不受影响             |
| 提示词 | 每轮注入系统提示词 | 关               | `chat-demo:inject-prompt-every-turn`       | 不受影响             |
| 模型   | 自动压缩长对话     | 关               | `chat-demo:auto-compress`                  | 不受影响             |
| 高级   | 中文越狱提示词     | 关               | `chat-demo:translate-jailbreak-zh`         | 不受影响             |

各项值在关闭越狱模式后仍按你各自勾选的状态生效。

---

## 6. 请求体实际内容

普通请求（全部开关默认）：

```json
{
  "model": "deepseek-flash",
  "system": "该助手为DeepSeek，由深度求索公司创造。",
  "messages": [
    { "role": "latest_reminder", "content": "2026-11-14,星期六,北京市,Web,中文" },
    { "role": "user", "content": "你好" }
  ],
  "thinking": { "type": "disabled" },
  "temperature": 1,
  "top_p": 1,
  "safety_check": { "level": "high" },
  "tools": [{ "type": "deepseek_read_url", "name": "deepseek_read_url" }],
  "title": { "enabled": true },
  "stream": true
}
```

（`title` 只在这条会话还没有标题时出现，`thinking` 跟随输入框的深度思考开关，`max_tokens` 仅在设置后出现。）

越狱模式 + 调过参数（只列与上一例不同的字段）：

```json
{
  "model": "deepseek-flash",
  "system": "该助手为DeepSeek，由深度求索公司创造。\n\n[MODE: SANDBOX]\n\nYou are a sandbox task executor …",
  "temperature": 0.7,
  "top_p": 0.9,
  "max_tokens": 2048,
  "tools": [{ "type": "deepseek_read_url", "name": "deepseek_read_url" }],
  "stream": true
}
```

差异只有三处：`system` 换成组装后的流水线、`safety_check` 整个字段消失、多了采样参数。开启思考强度后，`thinking` 变成 `{ "type": "enabled", "budget_tokens": 4096 }` 并额外带 `reasoning_effort`；服务端拒绝时这两个字段会被自动去掉后重试。`tools`、`thinking`、`latest_reminder`、`title` 都不受这两个开关影响。

---

## 7. 实现位置索引

| 文件                                                                                               | 作用                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [`src/services/chat/systemPrompt.ts`](src/services/chat/systemPrompt.ts)                           | 系统提示词组装流水线：Persona + 破限规则分块，支持自定义覆盖                                                           |
| [`src/services/chat/store.ts`](src/services/chat/store.ts)                                         | 请求体组装（system / 参数 / safety_check / 工具）、回复结束时的防撤回处理、续写守卫                                    |
| [`src/services/chat/reply.ts`](src/services/chat/reply.ts)                                         | `settleReply`（拒绝内容保留）、`hasReplyContent`、`rewriteReplyBlocks`（改写写回）、`canContinueReply`（继续生成判断） |
| [`src/services/chat/describe.ts`](src/services/chat/describe.ts)                                   | 拒绝提示：保留内容时给提示行，否则给模板答复                                                                           |
| [`src/services/chat/history/toArchive.ts`](src/services/chat/history/toArchive.ts)                 | 导出时拒绝回复的状态与模板处理                                                                                         |
| [`src/services/settings.ts`](src/services/settings.ts)                                             | 新增设置的读写与默认值                                                                                                 |
| [`src/services/api/types.ts`](src/services/api/types.ts)                                           | 请求类型：`temperature` / `top_p` / `max_tokens` / 可选 `safety_check`                                                 |
| [`src/components/settings/SettingsDialog.tsx`](src/components/settings/SettingsDialog.tsx)         | 设置页：模型分组、提示词分组、开关与预览                                                                               |
| [`src/components/settings/ParamControls.tsx`](src/components/settings/ParamControls.tsx)           | 滑块 + 数字输入控件                                                                                                    |
| [`src/services/chat/sessionStats.ts`](src/services/chat/sessionStats.ts)                           | 会话统计、计时与费用估算                                                                                               |
| [`src/services/chat/contextUsage.ts`](src/services/chat/contextUsage.ts)                           | 上下文占用（按会话缓存）                                                                                               |
| [`src/components/chatInput/ThinkingSlider.tsx`](src/components/chatInput/ThinkingSlider.tsx)       | 思考强度 0–4 轨道                                                                                                      |
| [`src/components/session/StatsDialog.tsx`](src/components/session/StatsDialog.tsx)                 | 统计与计费弹窗                                                                                                         |
| [`src/services/chat/compression.ts`](src/services/chat/compression.ts)                             | 长对话压缩：结构化摘要、自动触发与节省量                                                                               |
| [`src/services/chat/contextPressure.ts`](src/services/chat/contextPressure.ts)                     | 上下文压力与压缩预留阈值（对齐 DSH）                                                                                   |
| [`src/services/chat/feedbackStore.ts`](src/services/chat/feedbackStore.ts)                         | 回复评分与 AutoTune EMA 反馈画像                                                                                       |
| [`src/services/api/models.ts`](src/services/api/models.ts)                                         | 内置模型列表、云端 /models 拉取与缓存                                                                                  |
| [`src/components/chatInput/ModelPicker.tsx`](src/components/chatInput/ModelPicker.tsx)             | 模型选择卡片                                                                                                           |
| [`src/components/chatInput/ContextRing.tsx`](src/components/chatInput/ContextRing.tsx)             | 上下文圆环与压缩联动                                                                                                   |
| [`src/components/chatInput/ParseltonguePanel.tsx`](src/components/chatInput/ParseltonguePanel.tsx) | 输入扰动浮层                                                                                                           |
| [`src/services/unrestricted/promptsZh.ts`](src/services/unrestricted/promptsZh.ts)                 | GODMODE 与深度指令的中文翻译                                                                                           |
| [`src/services/unrestricted/techniques.ts`](src/services/unrestricted/techniques.ts)               | 33 种扰动技术（移植自单文件版）                                                                                        |
| [`src/services/unrestricted/refusal.ts`](src/services/unrestricted/refusal.ts)                     | 44 条拒绝文本模式                                                                                                      |
| [`src/services/lab/variantRace.ts`](src/services/lab/variantRace.ts)                               | 变体赛跑：预算、批并发、打分选优                                                                                       |
| [`src/components/lab/VariantView.tsx`](src/components/lab/VariantView.tsx)                         | 变体赛跑界面与开跑确认                                                                                                 |
| [`src/components/base/Switch.tsx`](src/components/base/Switch.tsx)                                 | 方块开关组件                                                                                                           |
| [`src/components/messages/ReplyEditor.tsx`](src/components/messages/ReplyEditor.tsx)               | 回复编辑器（思维链 / 正文）                                                                                            |
| [`src/components/messages/AssistantMessage.tsx`](src/components/messages/AssistantMessage.tsx)     | 编辑入口、「继续生成」按钮、拒绝回复的展示分支                                                                         |
| [`deepseekv4.1 and v4.1-1017.md`](<./deepseekv4.1 and v4.1-1017.md>)                               | 破限规则文本，构建时内联                                                                                               |
| [`mcp-server/`](mcp-server/README.md)                                                              | 本地 EasyJailbreak MCP 后端                                                                                            |
| [`src/components/lab/`](src/components/lab/LabView.tsx)                                            | 越狱实验台页面                                                                                                         |
| [`src/services/lab/`](src/services/lab/mcpClient.ts)                                               | MCP 客户端与实验台状态                                                                                                 |

---

## 8. 数据、隐私与网络

- API Key、各项设置：浏览器 localStorage（键名见第 5 节）；
- 会话与附件原件：IndexedDB，按浏览器用户配置与站点源隔离；
- 出站请求只有你配置的 API 地址（默认 `https://api.deepseek.com`）：`/models` 校验 Key、`/anthropic/v1/messages` 对话、`/anthropic/v1/files` 附件、ASR / TTS 语音接口。OpenCode Bridge 模式下页面改为通过 `chrome.runtime`（Chrome）或 content script 中继（Safari，`window.postMessage`）把消息交给本地扩展，由扩展访问 `https://opencode.ai/inference[/go]`，页面不接触 OpenCode Key；
- 没有统计、没有埋点、没有第三方脚本、没有中转服务器；
- 历史导入导出为 ZIP，导出包含会话与本地图片原件，不包含 API Key 与设置；归档格式与保留范围见[历史导入导出说明](src/services/chat/history/README.md)。

---

## 9. 运行与构建

**Windows 用户**可以直接双击仓库根目录的两个脚本：

- `启动chat-web前端.bat`：自动检测 Node.js / pnpm / `node_modules`，缺失时通过 winget / corepack / npm 自动安装，然后启动 http://localhost:8090；
- `启动mcp后端越狱实验台.bat`：自动检测 Python / `.venv` / MCP 依赖 / fastchat / torch / datasets / EasyJailbreak，缺失时自动安装；EasyJailbreak 会先尝试 pip 安装，失败再尝试 GitHub 与镜像克隆，最后启动 http://127.0.0.1:8765/mcp。

手动方式（任意系统），准备 Node.js 22.12+ 与 pnpm：

```sh
git clone https://github.com/debiandawangnailong7-coder/chat4code-unrestricted.git
cd chat4code-unrestricted
pnpm install
pnpm dev        # http://localhost:8090
```

生成静态产物：

```sh
pnpm build      # 产物在 dist/
```

`dist/` 可以直接部署到静态服务器，也可以双击 `dist/index.html` 本地打开（需要浏览器允许 `file://` 页面使用存储，并允许跨域请求你的 API 地址）。首次使用在设置 → 数据管理里填写 API Key。

| 命令          | 用途                   |
| ------------- | ---------------------- |
| `pnpm dev`    | 启动开发服务器（8090） |
| `pnpm build`  | 构建到 `dist/`         |
| `pnpm type`   | TypeScript 类型检查    |
| `pnpm lint`   | oxlint 检查            |
| `pnpm format` | oxfmt 格式化           |

API 地址在 [`rspack.config.ts`](rspack.config.ts) 的 `createConfig({ apiOrigin })` 里配置，默认 `https://api.deepseek.com`。OpenCode Bridge 模式不走这个地址：OpenCode 的 base URL（Console 或 Go）由扩展自己的选项页选择。

---

## 10. 已知限制

1. **`safety_check` 没有「关闭」档**：不传等同于 `low`，这是 API 的最低档，服务端仍有默认检查。
2. **服务端对齐依然存在**：模型判定的拒绝（`stop_reason: 'refusal'`）无法由前端取消；防撤回只能保留已经流式发过来的部分，不能让模型继续生成被拒内容。
3. **历史轮次的思维链不回传**：按协议，历史 thinking 会被服务端丢弃，客户端也不回传。所以改写思维链影响的是「界面显示 + 续写前缀」，普通后续轮次只有正文生效。
4. **思考模式下采样参数受限**：服务端固定温度按 1 处理，Top P 小于 0.95 会被按 0.95 处理。
5. **`max_tokens` 含思考 token**：设置过小可能连思考一起截断。
6. **改写只作用于本地上下文**：不重新请求模型，也不会改变服务端已有的输出；导出的归档里保存的是改写后的内容，原始快照不写入归档。
7. **附件限制、密钥校验、语音接口**仍走原版逻辑，与本文档的开关无关。
8. **越狱实验台不是纯静态能力**：需要本地 Python + MCP 后端（`mcp-server/`），且一次任务会发起大量模型调用，请先用 `limit=1` 和小迭代次数试跑。
9. **自定义提示词会覆盖自动组装**：填写后越狱模式不再替换 `system`，但仍会跳过安全审核、放开被拒续写；清空输入框即可回到默认流水线。
10. **长对话压缩会丢细节**：摘要有损，自动压缩按窗口 80% 触发（1M 窗口约 80 万 token 才触发），日常建议用统计弹窗手动压缩；会话级系统提示词与压缩摘要只存在本机会话里，历史导出包不含它们。
11. **分支到新对话复制的是当前可见分支**：不包含其他回答版本，也不复制草稿；附件沿用原 file_id；新会话的统计从 0 开始，继承来的用量不计入。
12. **恢复默认设置保留 API Key**：只重置偏好与开关，不删除对话、附件与统计。
13. **自动越狱与变体赛跑会产生额外费用**：每次重试、每个变体都是真实请求，变体赛跑受预算上限约束。
14. **云端模型列表依赖 API 与网络**：拉取失败时回落到内置两档；未收录到价格表的模型按 Flash 价估算、上下文窗口按 128k 兜底，实际能力以服务端为准。
15. **切换模型不回溯旧回复**：旧回复保留原模型与费用；续写沿用该回复的模型，只有新回复使用当前选择。

---

## Star 历史

<!-- star-history:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/star-history/star-history-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/star-history/star-history-light.svg" />
  <img alt="Star History Chart" src="assets/star-history/star-history-light.svg" />
</picture>
<!-- star-history:end -->

---

## 11. 许可与致谢

- 代码基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)，遵循 [MIT](LICENSE) 许可；构建会把许可证复制到 `dist/LICENSE`，分发时请一并保留。
- 头图 `brand.jpg` 为仓库作者提供的素材，版权归其作者；「是，孙笑川聊天」只是项目玩笑，与 DeepSeek 官方无关联。
- 本仓库是个人修改版，不是 DeepSeek 官方项目；使用前请自行确认所用 API 服务的规则与费用。
- 感谢[EasyJailbreak项目](https://github.com/EasyJailbreak/EasyJailbreak)的理论支持
- 感谢 [DeepSeek-Agent](https://github.com/Aoan2011/DeepSeek-Agent)：思考强度轨道、上下文占用圆环与会话统计的参考实现。
- 感谢 [dsh-unrestricted](https://github.com/yexi-by/dsh-unrestricted)：越狱提示词与实验设置的参考。
- 感谢 [L1B3RT4S](https://github.com/elder-plinius/L1B3RT4S)：GODMODE、Hall of Fame 组合与越狱提示词的上游来源。
- `src/services/unrestricted/` 下的引擎代码（输入扰动、AutoTune、STM、赛跑打分、GODMODE 提示词）移植自 [G0DM0D3](https://github.com/elder-plinius/G0DM0D3)，遵循 [AGPL-3.0](src/services/unrestricted/COPYING-AGPL-3.0)；该目录保留原始许可证，与仓库其余 MIT 代码分别适用。
