# Changelog

## 0.2.0 (2026-09-17)

- 分支索引层（branch-aware index）：项目名 `路径__分支`，一分支一库
- multi 模式：每仓库分支项目 LRU 上限（默认 6），切回已访问分支零重索引
- single 模式：DB 超 500MB 的大仓滚动单索引——每次使用核对当前检出分支，不一致删旧建新（稳态 1 库）
- legacy 零迁移采纳：存量路径派生名索引按当前分支直接沿用（签名全等 verified / 无快照 unverified，对齐保鲜门控既有语义）
- 查询族操作新增 `branch` 参数（已建索引分支；非检出分支为冻结态不做保鲜）
- `op=status` 增当前分支/模式/可用分支清单；响应新增 branch/branchMode/adopted/built/switched/evicted/fresh 元数据
- detached HEAD → `__detached-<sha7>` 命名；非 git 目录与 `branchIndex=false` 回退单索引跟随行为
- 插件 id 调整：`@dsh-external/dsh-code-graph` → `@hoyyang/dsh-code-graph`（npm 防混淆规则禁用无 scope 的 dsh-code-graph，registry 建议形态）

## 0.1.0 (2026-09-08)

- 首版：单入口 `codegraph` 分发器（projects/status/index/changes/query/callers/callees/impact/trace/architecture/snippet）
- 保鲜门控（HEAD+脏树签名，漂移自动 fast 增量重索引，节流防抖）
- 图查询零命中自动回落 ripgrep/grep（显式标注 fallback）
- 四层触发（工具 + /codegraph 命令 + skill + 条件提示）+ tools/pre-execute 读代码门禁（config.gate，默认开，fail-open）
