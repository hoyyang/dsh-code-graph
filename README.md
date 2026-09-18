# dsh-code-graph

![banner](assets/banner.svg)

给 DSH 装上「预索引的代码知识图谱」：Agent 读代码不再盲 grep，而是查调用链、影响面、数据流——**切分支自动跟随，索引图永远对应当前检出分支**。

[**English**](README.en.md) · [Releases](https://github.com/hoyyang/dsh-code-graph/releases) · [更新日志](CHANGELOG.md)

![version](https://img.shields.io/badge/version-0.2.0-blue) ![dsh-plugin](https://img.shields.io/badge/dsh--plugin-toolkit-green) ![license](https://img.shields.io/badge/license-MIT-green)

## 安装

```bash
# GitHub
dsh plugin add github:hoyyang/dsh-code-graph

# 或 npm
dsh plugin add @hoyyang/dsh-code-graph
```

- **零配置可用**：装上即生效，读代码门禁默认开启，无需任何账号或 API Key。
- **依赖**：本机需有 [codebase-memory](https://github.com/DeusData/codebase-memory-mcp) 引擎二进制（默认 `~/.local/bin/codebase-memory-mcp`，可用 `config.bin` 改路径）。引擎缺失时 fail-loud 点名报错，不影响 DSH 启动。
- **卸载**：`dsh plugin --profile web remove dsh-code-graph`——卸载即净：工具/命令/提示 section/skill 文件/状态文件全部自动清理，不碰图数据库与用户仓库。

## 有啥用

- **结构化读代码**：`callers` /`callees` /`impact`（调用方逐层 BFS）/ `trace`（调用与数据流路径）/ `architecture`（架构概览），LSP 级跨文件解析，覆盖 158+ 语言。
- **分支自动跟随**：检出任意分支后直接提问，索引图自动对应当前分支——切回访问过的分支**零重索引**（每分支一份持久图，LRU 上限防膨胀）。
- **大仓滚动单索引**：超过 500MB 的仓库只保留当前分支一份索引，切分支删旧建新，**磁盘占用恒为 1 份**。
- **保鲜门控**：每次查询比对 HEAD+脏树签名，漂移自动 fast 增量重索引（节流防抖），答案永远对应当前工作树。
- **永不空手**：图查询零命中自动回落 ripgrep（无 rg 用 grep），结果显式标注 fallback，绝不冒充图结果。
- **读代码硬门禁**：未先调 codegraph 的代码 grep 会被拒绝并给出引导；门禁自身异常一律放行（fail-open，绝不阻塞工具链）。
- **schema 经济**：只注册 1 个分发器工具（11 个操作），对比 MCP 方案 20+ 工具定义/请求，省 ~90% schema 开销。
- **跨分支查询**：`branch` 参数直查已建索引的非检出分支（冻结态，不做保鲜）。

## 30 秒上手

1. 让 Agent 直接问："这个函数被谁调用？"——Agent 会自动走 codegraph（门禁保证触发）。
2. 输入 `/codegraph` 查看已索引项目与分支状态。
3. 新仓库建索引：`/codegraph <仓库绝对路径> fast`（也支持 moderate/full）。
4. Agent 侧查询示例：`codegraph { "op": "callers", "repo_path": "<repo>", "name": "handleRequest" }`
5. 切分支后不用做任何事：`git checkout release/x` 后继续提问，索引自动跟随。

## 进阶用法

### 分支管理

- 索引按分支组织，分支项目名 = `路径__分支`（一分支一库）。
- **multi 模式**（常规仓）：每分支一份持久索引图，LRU 上限 `maxBranchProjects`（默认 6）；切回已访问分支零重索引。
- **single 模式**（大仓，DB > `branchIndexMaxDbBytes` 即 500MB）：每仓只留当前分支一份索引；每次使用核对当前检出分支，不一致删旧建新（fast 全量重建，可能分钟级）——稳态磁盘恒 1 份。
- `branch` 参数：`codegraph { "op": "callers", "repo_path": "<repo>", "branch": "release/x", "name": "..." }`——仅限已建索引分支；非检出分支为冻结态（不做保鲜）。
- detached HEAD 按 `__detached-<sha7>` 命名；非 git 目录与 `branchIndex=false` 时回退单索引跟随行为。
- `op=status` 返回当前分支、模式（multi/single）与可用分支清单。

### 配置

| 键 | 默认 | 说明 |
|---|---|---|
| bin | ~/.local/bin/codebase-memory-mcp | 引擎二进制路径 |
| defaultMode | fast | index 默认模式（fast/moderate/full） |
| fresh | true | 查询前保鲜门控 |
| freshThrottleSec | 120 | 重索引防抖窗口（秒） |
| maxRows | 50 | 查询返回行数上限 |
| hint | true | 条件系统提示开关 |
| skill | true | skill 文件落盘开关 |
| gate | true | grep 门禁开关（未先调 codegraph 的代码 grep 被 deny） |
| branchIndex | true | 分支索引层总开关（false 回退单索引跟随行为） |
| maxBranchProjects | 6 | multi 模式每仓库分支项目上限（LRU） |
| branchIndexMaxDbBytes | 524288000 | 超过该 DB 字节数转 single（大仓滚动单索引）模式 |

### 操作一览（单工具分发器）

| op | 用途 |
|---|---|
| projects | 列已索引项目 |
| status | 索引状态 + 分支清单 |
| index | 建/增量索引（仅主 agent） |
| query | BM25 符号/全文检索 |
| callers / callees | 直接调用关系 |
| impact | 向上影响面 BFS（深度 1-8） |
| trace | 调用/数据流路径 |
| architecture | 架构概览 |
| snippet | 按 qualified_name 取代码 |
| changes | 变更检测（git ref 级） |

## 工作原理

插件是 DSH 原生 toolkit：唯一工具 `codegraph` 按需 spawn 本机 codebase-memory 引擎 CLI（JSON 走 stdin，空闲即走，无常驻连接、零 MCP 会话）。索引按分支持久化为独立图库；查询前做保鲜门控（HEAD+脏树签名比对）；`tools/pre-execute` 事件上挂读代码门禁；分支层在查询时惰性解析当前检出分支并维护分支注册表（LRU 淘汰 / 大仓单槽清理），全程不修改用户仓库文件、不装 git hooks。

## 可靠性与验收

- **回归自测**：29 项端到端用例（legacy 行为 13 / multi 分支 10 / single 单槽 5 / 存量采纳 1）——`node scripts/selftest-ops.mjs`，ALL PASS。
- **引擎契约 spike**：6 项关键行为实测（--name 一名一库 / 删除真回收 / 同名增量 / 未提交改动感知 / 分支切换重建正确 / size_bytes 阈值）。
- **活体验收**：存量仓库零迁移采纳（不触发重索引）；分支往返四场景（提交→漂移重索引、新分支→自动建图、跨分支冻结查询、切回→零重索引）全部通过。
- **门禁回归**：全新会话 grep 拦截（拒绝原文逐字）/ codegraph 后放行 / 门禁 fail-open 三态验证。
- **生命周期**：热重载 fiber 重建验证；卸载零残留（工具/命令/section/skill/状态文件）；重装幂等。

## 常见问题

- **切分支后要手动重索引吗？** 不需要。查询自动解析当前检出分支：已有该分支索引直接复用，没有则自动 fast 建图。
- **大仓切分支慢？** single 模式下是全量重建（分钟级），这是为磁盘占用恒定付出的代价；不介意多占空间可调大 `branchIndexMaxDbBytes` 转 multi 模式。
- **没装引擎会怎样？** 工具调用 fail-loud 点名报错并给安装指引；DSH 启动与门禁放行逻辑不受影响。
- **会修改我的仓库吗？** 不会。不装 git hooks、不写 .gitignore、不启动常驻监听、不改任何仓库文件。
- **为什么我的 grep 被拒绝了？** 门 11 读代码强制路由：先调一次 codegraph（确认可用或不可用）后 grep 即放行；bash 里直接跑 rg/grep 不受影响。

## 本地构建

```bash
git clone https://github.com/hoyyang/dsh-code-graph && cd dsh-code-graph
bash scripts/build.sh          # pnpm/npm 装依赖 + tsc 编译（自包含）
node scripts/selftest-ops.mjs  # 29 项端到端回归（需引擎二进制）
```

## 许可证

[MIT](LICENSE)
