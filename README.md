<h1 align="center">chat4code-unrestricted</h1>

<p align="center">
  一个静态 DeepSeek 聊天前端<br>
  <a href="https://dawangnailong.github.io/chat4code-unrestricted/">在线版</a> ·
  <a href="https://github.com/dawangnailong/chat4code-unrestricted">仓库</a> ·
  <a href="https://github.com/dawangnailong/opencode-bridge">OpenCode Bridge</a>
</p>


> 这是 `xiaohuangbo/chat-demo-unrestricted` 的 fork。完整功能、设置项、请求体、实现索引与已知限制，见[上游 README](https://github.com/xiaohuangbo/chat-demo-unrestricted/blob/main/README.zh-CN.md)。
>
> 下面一大段主要写三条我们自己的判断作为 fork 的增量。

---

## 1. 低成本聊天服务，应受到支持

### 1.1 免费聊天限额之后

2026 年 11 月 16 日起，多家媒体报道 DeepSeek 免费 App/网页聊天出现限制：超过 7 天不活跃的长对话不能继续、单次输入约 4 万字上限、每日对话额度（用尽时提示“因服务器繁忙，使用额度已达上限”）。截至报道时没有官方统一公告；限制只影响消费端，API 不受影响。据同期报道，消费端没有可升级的付费聊天档位，唯一付费路径是开发者 API。

来源：[光明网](https://m.gmw.cn/2026-11/16/content_1304586782.htm)、[新浪财经](https://finance.sina.com.cn/wm/2026-11-16/doc-iniyxcif2449372.shtml)、[什么值得买的 DeepSeek 计费拆解](https://post.smzdm.com/p/a826qpv6/)（第三方分析，仅供参考）。

### 1.2 “去用 API”并不便宜

官方价格页：[DeepSeek API Pricing](https://api-docs.deepseek.com/quick_start/pricing)。下表为美元/百万 token，谷时 / 峰时；峰时 = 谷时 ×2，峰时为北京时间工作日 09:00–12:00、14:00–18:00。

| 模型 | 缓存命中 | 输入（未命中） | 输出 |
|---|---:|---:|---:|
| `deepseek-flash` | $0.003 / $0.006 | $0.15 / $0.30 | $0.60 / $1.20 |
| `deepseek-v4-pro` | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

在聊天中的典型场景是长陪伴聊天：常开好几个对话窗口，每个窗口攒下几万 token 的历史，回答不合预期导致反复重新生成——有用户让模型重复回答了 6000 多遍（[用量分析截图](https://pic2.zhimg.com/v2-3b01540297cb43522435380449b74977_1440w.jpg)）。按真实行为重新估计（人民币按 1 USD ≈ 7.2 CNY，谷时价格，峰时翻倍；实际以账单为准）。关键机制：每次回复都要重读全部历史，所以**每日输入 ≈ 每日生成次数 × 平均上下文**；重新生成按每条消息多生成 1 次计，修改输入只让尾部少量 token 未命中，历史部分仍命中缓存：

| 场景 | 活跃窗口 | 平均上下文 | 每日生成 | 每日输入 | 每日输出 | 缓存命中 | V4 Pro 谷时/天 | Flash 谷时/天 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 轻度问答 | 1 | 8K | 20 | 160K | 10K | 80% | ≈0.32 元 | ≈0.08 元 |
| 标准问答 | 1 | 20K | 50 | 1M | 50K | 80% | ≈1.79 元 | ≈0.45 元 |
| 轻度长陪伴 | 1 | 10K | 30 | 300K | 30K | 80% | ≈0.75 元 | ≈0.20 元 |
| 典型长陪伴 | 5 | 30K | 300 | 9M | 300K | 70% | ≈18 元 | ≈4.3 元 |
| 重度长陪伴 | 20 | 30K | 2000 | 60M | 2M | 70% | ≈121 元 | ≈29 元 |

场景设定：典型长陪伴 = 5 个常开窗口 × 3 万上下文 × 每窗口约 30 轮；重度 = 分析里“数十个窗口”的极端用法（6000 多遍那种属于更高的个例）。缓存命中率是表里最敏感的假设：连续聊天时历史基本命中，隔天回来缓存过期则明显上浮。

**“一天聊出几十块”不是空穴来风**：典型长陪伴 V4 Pro 谷时约 18 元/天、峰时约 36 元；重度长陪伴谷时约 121 元/天、峰时约 240 元。Flash 便宜一个量级，但典型长陪伴也要 4.3 元/天（谷时）/ 8.6 元（峰时），重度 29 / 58 元/天。

实际情况只会更差：我们用 agent harness 跑过一次普通的 README 重写任务，3 元多——这不像是我们做法错了，也不像是这个任务本应这么贵。社区里推荐的 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（及 [dsh-go](https://github.com/ccch1mneyyy/dsh-go)）本来就不是为聊天设计的，一次简单问答超过几块钱的量级是可能的，日常长对话只会更高。我们想帮的正是这类人——比如被“算力不足”挡在门外的[许肃们](https://www.sina.cn/news/detail/5366018630227784.html)（[聊天截图](http://wx1.sinaimg.cn/middle/6dd57921ly1ij4fu87rejj20te1ks1bl.jpg)）。走 OpenCode Go 的 API 通道，同样的用量，理论上是 1/10 的成本，考虑到缓存策略差异与 API 兼容差距，我们粗略估计成本可以压一些，比如压到约 1/5 的成本，并且不用过中转站。这就是第 1.4 节路径的意义。

### 1.3 “为什么不在谷时用”不是答案

峰时是工作日 09:00–12:00、14:00–18:00；其余时间才是谷时，包括晚上、周末和节假日。要求聊天用户按 API 折扣时段安排生活，不是产品方案。对普通用户来说，“去用 API”和“为什么不在谷时用”都不构成一个可用的方案。

### 1.4 我们在推的路径：OpenCode Go + opencode-bridge

OpenCode Go：**$10/月**；Go Plus：**$40/月**；Go Teams：**$20/人/月**（2 人起）。Go 的“只用某个模型”的月度额度：DeepSeek V4.1 Flash 1017（应用里的 `deepseek-flash`）= **$100**，DeepSeek V4 Pro = **$15**；Plus 分别为 $200 / $60。额度按 5 小时 20%、每周 50%、每月 100% 释放，所有付费模型共用一个池。

按 7.2 汇率，$10 ≈ **72 元/月**：30 天摊 **2.4 元/天**，22 个使用日摊 **3.3 元/天**。这就是“3 元整天”的来源——是订阅摊薄，不是单次请求单价。$100 的 Flash 月度额度，按 $0.15/M 输入价折算约 **6.66 亿输入 token**（只算输入的上限）；5 小时窗口的 $20 ≈ 1.33 亿输入 token，远高于聊天用量。

按“标准”问答用量（50 生成/天、1M 输入、50K 输出、80% 缓存）：V4 Pro 每天约 $0.25（约 1.8 元），$15 月额度够一个人用满一个月；Flash 每天约 $0.06（约 0.45 元）。

长陪伴才是额度压力测试：典型长陪伴（5 窗、9M 输入/天、300 生成、70% 缓存）用 Flash 每天约 $0.60（约 4.3 元），一个月约 $18，$100 额度覆盖；重度长陪伴 Flash 每天约 $4.0（约 29 元），一个月约 $121，连 Go 的 $100 额度也会超。用 V4 Pro：典型长陪伴约 $2.5/天，一个月约 $75，超过 Go 的 $15，也超过 Go Plus 的 $60；重度约 $16.8/天，一个月约 $500，只能按量或走 Extra Usage。长陪伴的低成本路径是 Flash，同时主动控制窗口数与重新生成；V4 Pro 长陪伴走按量或 Go Plus + Extra Usage。

**但 Go 不是无条件最便宜。** 按“标准”问答的 V4 Pro 用量，按量 API 一个月约 54 元，低于 Go 的 72 元；但长陪伴会迅速反超——V4 Pro 典型长陪伴按量一个月约 540 元，Flash 约 130 元，Go 的成本封顶这时才明显；重度长陪伴连 Go/Go Plus 的封顶都压不住，超出部分只能走 Extra Usage。Go 买的是成本封顶、不用盯 token 和多模型额度；轻度/标准问答按量可能更省，长陪伴才是 Go 的主场。额度用尽后可开 Extra Usage 走 Console 余额，或切换免费模型；Go 不是“无限量”。

官方把 Go 定位为编程模型订阅；用于聊天属于非典型用法，合规性请自行核对 OpenCode 条款。Bridge 只做传输：本地存 key、Origin 白名单、无遥测、不帮助绕过限额、不冒充官方客户端；合规责任在用户。本项目与 OpenCode 无隶属关系；价格、额度与条款以官方页面为准，可能随时调整。

链接：[OpenCode Go](https://opencode.ai/go)、[Go 文档](https://opencode.ai/docs/console/go)、[额度表](https://opencode.ai/console/go)、[opencode-bridge](https://github.com/dawangnailong/opencode-bridge)。

### 1.5 关于共号

> 本节只是讲一些已知的共号利弊，具体的做法请用户自己衡量。笔者认为这是订阅制度导致的自然想法，提供相关的信息参考，更有助于用户的决策。不提倡，也不因此正面赞成“有头脑”，抑或其他负面的直接评价。

- 一份 $10 Go 由 N 人共用：人均 **72/N 元/月**；3 人 ≈ 24 元/人/月 ≈ 0.8–1.1 元/天。
- 额度是共享池：3 个“标准问答”用户一个月约消耗 $5.6 的 Flash 额度（$1.87/人/月 ×3），$100 池够用；V4 Pro 的 $15 池只够约 2 个标准问答用户（$7.46/人/月 ×2 ≈ $14.9），第 3 个就超了。
- 长陪伴：3 个典型长陪伴用户共用 Flash 池约 $54/月（$18.1/人/月 ×3），$100 勉强够；V4 Pro 一个人就 $75/月，$15 池和 Go Plus 的 $60 都不够。
- 这也是共号最有诱惑力的地方：3 人分摊 24 元/人/月，而单人按量 Flash 长陪伴约 130 元/月。差距足以让人动心，但条款仍然禁止。

把得失放在一起看，帮助你自己判断：共号的收益是把单人约 130 元/月的 Flash 长陪伴用量摊到 24 元/人，代价是违反条款、共享 key 的安全与隐私、以及额度池谁先用完先受限。我们目前没有看到官方针对共号/key 分享的公开处罚升级，网上公开分享 key 的行为艺术也未见明显追责——但这只是观察，不构成许可，条款仍然有效，服务方随时可以改变态度。

## 2. 聊天服务，不是手术台

上游的强项是功能齐全：越狱实验台、扰动、AutoTune、记忆、投毒、统计一应俱全；它服务的是愿意折腾的用户。我们想做的略有不同：**普通用户的聊天服务**。典型用户是角色扮演、长对话、日常聊天的人，不是只想折腾实验台的人。

具体界面形态我们还没有答案。一个并不成立的方向是“打开就是聊天、人设提示词记忆费用提醒在后台工作、能力进设置、入口守恒”：把问题当成了“功能放在哪里”，而我们不满意的地方不是功能的展开和折叠隐藏。chat4code 服务应该是什么样，我们还在想。

## 3. Agent 能力是下一步（规划中）

> 状态：规划中，尚未落实。下面写的是方向，不是现有功能。

OpenCode Bridge 已经让浏览器接入 OpenCode Console/Go 推理，聊天可以使用编程模型。下一步，chat4code 打算加入一定的 agent 能力；具体形态待定，原则是聊天优先、能力有限，不是把聊天页改成 IDE，也不是完整 coding agent。

和第 2 点一样：agent 应该服务于聊天体验，在后台多步完成任务，而不是在界面上加一个 Agent 面板/手术台。能力放进循环，不放进按钮。

参考：[opencode-bridge](https://github.com/dawangnailong/opencode-bridge)、[OpenCode 文档](https://opencode.ai/docs/console/go)、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（agent harness 的参照；本项目尚未实现同等能力）。

## 快速开始

1. **在线版（推荐）**：打开 <https://dawangnailong.github.io/chat4code-unrestricted/>，在 设置 → 数据管理 填 DeepSeek API Key。key 只留在浏览器，本前端不经过第三方中转。
2. **可选：OpenCode Go**：
   - 安装 opencode-bridge 扩展（Chrome 开发者模式加载已解压的扩展；Safari 16.4+ 用 `xcrun safari-web-extension-converter` 转换并启用；Firefox 需 121+）。
   - 在扩展选项页把当前页面 Origin 加入 Allowed origins，User-Agent 设为 `chat4code-unrestricted/1.0.0`，选择 Console 或 Go 的 Base URL，并把 OpenCode API Key 保存在扩展里（不要填到应用里）。
   - 在 设置 → 数据管理 → 推理通道 选 OpenCode Bridge，填扩展 ID（Chrome 在 `chrome://extensions` 复制，Safari 填 bundle identifier），点“测试连接”。
   - Safari 还需在 设置 → 扩展 → OpenCode Bridge → 网站访问 中允许本站并刷新；`file://` 会被扩展拒绝，请用 http(s) 地址。
3. Bridge 模式暂不支持文档附件、语音识别/朗读、服务端联网搜索与实验台；图片以 base64 内联，每次请求只内联最近 1–10 张（需扩展 v0.2.0+）。
4. **本地构建（可选）**：`pnpm install` → `pnpm dev`（http://localhost:8090）→ `pnpm build`（输出 `dist/`）。Windows 可双击 `启动chat-web前端.bat`。
5. Android APK 见 `android/README.md`。

## 已知边界

- 这是客户端：服务端的安全审核、模型对齐与撤回无法被客户端取消；`unrestricted` 是请求可配置，不是服务端无限制。
- Bridge 模式只发标准 Anthropic Messages，DeepSeek 专属字段会被剥离；文档附件、语音、服务端搜索与实验台在该模式不可用。
- Agent 能力尚未实现；文中标注“规划中”的内容不是现有功能。
- Go 的价格、额度与执行力度可能随时变化；共号违反条款，本文不提供做法。
- 本项目不是 DeepSeek 官方项目，与 OpenCode 无隶属关系；使用前自行确认所接服务的条款与费用。

## 许可证与致谢

- 代码基于 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 与 [xiaohuangbo/chat-demo-unrestricted](https://github.com/xiaohuangbo/chat-demo-unrestricted)，遵循 [MIT](LICENSE) 许可；构建会把许可证复制到 `dist/LICENSE`，分发时请保留。
- `src/services/unrestricted/` 下的引擎代码（输入扰动、AutoTune、STM、赛跑打分、GODMODE 提示词）移植自 [G0DM0D3](https://github.com/elder-plinius/G0DM0D3)，遵循 [AGPL-3.0](src/services/unrestricted/COPYING-AGPL-3.0)；该目录保留原始许可证，与仓库其余 MIT 代码分别适用。
- 上游的头图（`brand.jpg` 等“孙笑川聊天”玩笑素材）在本 fork 已移除；本仓库不是 DeepSeek 官方项目，与上游的玩笑无关联。
- 感谢 [EasyJailbreak](https://github.com/EasyJailbreak/EasyJailbreak) 的理论支持。
- 感谢 [DeepSeek-Agent](https://github.com/Aoan2011/DeepSeek-Agent)：思考强度轨道、上下文占用圆环与会话统计的参考实现。
- 感谢 [dsh-unrestricted](https://github.com/yexi-by/dsh-unrestricted)：越狱提示词与实验设置的参考。
- 感谢 [L1B3RT4S](https://github.com/elder-plinius/L1B3RT4S)：GODMODE、Hall of Fame 组合与越狱提示词的上游来源。
- 感谢 [Operit](https://github.com/AAswordman/Operit)：网状记忆库的参考实现。
- 感谢 [DeepChat](https://github.com/YanJiuWeiYuanHui/DeepChat)：长期记忆与每日 Token / 费用提醒的参考。

## Star History

<!-- star-history:start -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/star-history/star-history-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="assets/star-history/star-history-light.svg" />
  <img alt="Star History Chart" src="assets/star-history/star-history-light.svg" />
</picture>
<!-- star-history:end -->
