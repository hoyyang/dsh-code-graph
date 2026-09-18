# dsh-code-graph

![banner](assets/banner.svg)

A pre-indexed code knowledge graph for DSH: your agent stops blind-grepping and starts querying call chains, impact and data flow — **branch-aware, the graph always matches your checked-out branch**.

[**中文**](README.md) · [Releases](https://github.com/hoyyang/dsh-code-graph/releases) · [Changelog](CHANGELOG.md)

![version](https://img.shields.io/badge/version-0.2.0-blue) ![dsh-plugin](https://img.shields.io/badge/dsh--plugin-toolkit-green) ![license](https://img.shields.io/badge/license-MIT-green)

## Install

```bash
# GitHub
dsh plugin add github:hoyyang/dsh-code-graph

# or npm
dsh plugin add @hoyyang/dsh-code-graph
```

- **Zero config**: works out of the box; the code-read gate is on by default. No accounts, no API keys.
- **Dependency**: a local [codebase-memory](https://github.com/DeusData/codebase-memory-mcp) engine binary (default `~/.local/bin/codebase-memory-mcp`, override via `config.bin`). Missing engine fails loud with a named error; DSH startup is unaffected.
- **Uninstall**: `dsh plugin --profile web remove dsh-code-graph` — clean removal: tool/command/prompt section/skill file/state file are all cleaned up automatically. Your graph databases and repositories are never touched.

## Why

- **Structured code reading**: `callers`, `callees`, `impact` (BFS over callers), `trace` (call & data-flow paths), `architecture` (overview) — LSP-grade cross-file resolution across 158+ languages.
- **Branch-following indexes**: check out any branch and just ask; the graph automatically matches. Switching back to a visited branch is **zero-reindex** (one persistent graph per branch, LRU-capped).
- **Rolling single index for huge repos**: repos whose graph DB exceeds 500MB keep exactly one branch index; switching branches deletes the old graph and rebuilds — **disk stays flat**.
- **Freshness gate**: every query compares a HEAD + dirty-tree signature and auto-fast-reindexes on drift (debounced), so answers always match your working tree.
- **Never empty-handed**: zero graph hits fall back to ripgrep (grep if absent), explicitly labeled as fallback.
- **Code-read gate**: a bare code grep without a prior codegraph call gets denied with guidance; the gate itself fails open and never blocks the toolchain.
- **Schema economy**: exactly 1 dispatcher tool (11 ops) instead of 20+ MCP tool definitions — ~90% less schema overhead per turn.
- **Cross-branch queries**: the `branch` parameter queries an indexed non-checked-out branch (frozen snapshot, freshness skipped).

## 30-second start

1. Ask your agent: "who calls this function?" — it goes through codegraph automatically (the gate guarantees it).
2. Type `/codegraph` to list indexed projects and branch state.
3. Index a new repo: `/codegraph <absolute-path> fast` (or moderate/full).
4. Agent-side query: `codegraph { "op": "callers", "repo_path": "<repo>", "name": "handleRequest" }`
5. After `git checkout release/x` just keep asking — the index follows automatically.

## Advanced

### Branch management

- Indexes are organized per branch; branch projects are named `path__branch` (one graph per branch).
- **multi mode** (regular repos): one persistent graph per branch with an LRU cap (`maxBranchProjects`, default 6); revisiting a branch is zero-reindex.
- **single mode** (huge repos, DB > `branchIndexMaxDbBytes` = 500MB): only the current branch's graph is kept; every use verifies the checked-out branch and deletes-then-rebuilds on mismatch (fast full rebuild, can take minutes) — steady-state disk is exactly one graph.
- `branch` parameter: `codegraph { "op": "callers", "repo_path": "<repo>", "branch": "release/x", "name": "..." }` — only for indexed branches; non-checked-out branches are frozen (freshness skipped).
- Detached HEAD names projects `__detached-<sha7>`; non-git directories and `branchIndex=false` fall back to single follow-HEAD behavior.
- `op=status` reports the current branch, mode (multi/single) and the available branch list.

### Config

| key | default | description |
|---|---|---|
| bin | ~/.local/bin/codebase-memory-mcp | engine binary path |
| defaultMode | fast | default index mode (fast/moderate/full) |
| fresh | true | freshness gate before queries |
| freshThrottleSec | 120 | reindex debounce window (seconds) |
| maxRows | 50 | max rows per query |
| hint | true | conditional system-prompt hint |
| skill | true | write skill file |
| gate | true | grep gate (code greps without a prior codegraph call are denied) |
| branchIndex | true | branch layer master switch (false = legacy follow-HEAD behavior) |
| maxBranchProjects | 6 | per-repo branch project cap in multi mode (LRU) |
| branchIndexMaxDbBytes | 524288000 | DB size above which a repo switches to single (rolling) mode |

### Ops (single dispatcher tool)

| op | purpose |
|---|---|
| projects | list indexed projects |
| status | index status + branch inventory |
| index | create / incremental index (main agent only) |
| query | BM25 symbol/full-text search |
| callers / callees | direct call relations |
| impact | caller BFS (depth 1-8) |
| trace | call / data-flow paths |
| architecture | architecture overview |
| snippet | fetch code by qualified_name |
| changes | change detection (git ref) |

## How it works

The plugin is a native DSH toolkit: a single `codegraph` tool spawns the local codebase-memory engine CLI on demand (JSON over stdin, exits when idle — no persistent connections, zero MCP sessions). Indexes persist per branch as separate graph DBs; a freshness gate compares a HEAD+dirty-tree signature before every query; the code-read gate hooks `tools/pre-execute`; the branch layer lazily resolves the checked-out branch at query time and maintains a branch registry (LRU eviction / single-slot pruning). It never modifies your repositories, never installs git hooks.

## Reliability & verification

- **Regression suite**: 29 end-to-end cases (legacy 13 / multi 10 / single 5 / adoption 1) — `node scripts/selftest-ops.mjs`, ALL PASS.
- **Engine contract spikes**: 6 behaviors verified (`--name` one-name-one-DB, delete reclaims, same-name incremental, uncommitted-change detection, branch-switch rebuild correctness, size_bytes threshold).
- **Live verification**: zero-migration adoption of existing indexes; four-scenario branch round-trip (commit→drift reindex, new branch→auto-build, frozen cross-branch query, switch-back→zero reindex).
- **Gate regression**: fresh-session grep denial (verbatim), allow-after-codegraph, fail-open behavior.
- **Lifecycle**: hot-reload fiber rebuild verified; uninstall leaves zero residue; reinstall is idempotent.

## FAQ

- **Do I need to reindex after switching branches?** No. Queries resolve the checked-out branch automatically: reuse the branch graph if it exists, otherwise build one (fast).
- **Branch switching feels slow on a huge repo?** In single mode it's a full rebuild (minutes) — the price of flat disk usage. Raise `branchIndexMaxDbBytes` to switch to multi mode if you prefer space over speed.
- **What if the engine is missing?** Tool calls fail loud with a named error and install guidance; DSH startup and gate fall-open logic are unaffected.
- **Does it modify my repositories?** Never. No git hooks, no .gitignore writes, no watchers, no repository file changes.
- **Why was my grep denied?** The code-read routing gate: call codegraph once (to confirm availability or not) and grep is allowed afterwards. Running rg/grep inside bash is unaffected.

## Build from source

```bash
git clone https://github.com/hoyyang/dsh-code-graph && cd dsh-code-graph
bash scripts/build.sh          # deps + tsc (self-contained)
node scripts/selftest-ops.mjs  # 29-case regression (needs the engine binary)
```

## License

[MIT](LICENSE)
