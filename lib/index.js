/**
 * @dsh-external/dsh-code-graph — 单入口原生代码图工具包。
 *
 * 设计要点（设计卡已确认，2026-09-08）：
 * - schema 经济：只注册 1 个分发器工具（对比 MCP 两引擎 20+ 条/请求）；
 * - 零 MCP：后端 = codebase-memory 引擎 CLI 模式按需 spawn，空闲即走，无常驻连接；
 * - 四层触发：工具常驻 + /codegraph 命令（100% 确定性）+ skill 触发词 + 条件提示 section；
 * - 保鲜门控：查询前 head_sha/脏树比对，漂移自动 fast 增量重索引（节流防抖）；
 * - 分支索引层：multi 每分支一库（路径@分支，LRU 上限）；single 大仓滚动单索引（每次使用核对分支，不一致删旧建新）；
 * - 永不空手：图零命中自动回落 ripgrep 并显式标注；
 * - 生命周期：全部资源挂 ctx.effect，卸载即净（含 skill 文件删除），重装幂等。
 *
 * HostCtx 采用本地窄类型（dsh-concise 同款先例）：只声明实际用到的服务面，
 * 不与宿主 cordis 版本类型耦合；运行时由宿主注入真实服务。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { dispatchOp } from './ops.js';
import { runEngine } from './engine.js';
import { SKILL_MARKDOWN } from './skill.js';
export const name = 'dsh-code-graph';
export const inject = ['tools', 'commands', 'systemPrompt'];
export const Config = z.object({
    bin: z.string().default('~/.local/bin/codebase-memory-mcp'),
    defaultMode: z.string().default('fast'),
    fresh: z.boolean().default(true),
    freshThrottleSec: z.number().default(120),
    maxRows: z.number().default(50),
    hint: z.boolean().default(true),
    skill: z.boolean().default(true),
    gate: z.boolean().default(true),
    branchIndex: z.boolean().default(true),
    maxBranchProjects: z.number().default(6),
    branchIndexMaxDbBytes: z.number().default(524288000),
});
/** 已索引项目缓存：systemPrompt section 与 /codegraph 复用，工具调用时惰性刷新。 */
const projectCache = { names: [] };
async function refreshProjects(opts) {
    try {
        const r = await runEngine(opts, 'list_projects', {}, 20_000);
        const list = r.data?.projects ?? [];
        projectCache.names = list.map((p) => p.name ?? p.project).filter(Boolean);
    }
    catch { /* 引擎缺失时提示区保持空；fail-loud 由工具调用负责 */ }
    return projectCache.names;
}
/**
 * 本插件是否仍列在装配清单里（profile 的 bundles/dependencies 或超级注入器 registry）。
 *
 * 卸载清理只在「确属卸载」时才删用户可见产物（预设目录 / 技能文件）：重装配时清单里
 * 仍然有本插件，真卸载时它已被移除。清单读不到时按「仍安装」处理——宁可留下一个
 * 文件，也不能把正在用的资产删掉。
 * @param dshHome - harness home（DSH_HOME 或 ~/.dsh）。
 * @returns true 表示清单里仍有 @dsh-external/dsh-code-graph。
 */
function stillInstalled(dshHome) {
    try {
        for (const dir of readdirSync(join(dshHome, 'profiles'))) {
            try {
                const pkg = JSON.parse(readFileSync(join(dshHome, 'profiles', dir, 'package.json'), 'utf8'));
                if ((pkg.dsh?.profile?.bundles ?? []).some((b) => String(b).includes('dsh-code-graph')))
                    return true;
                if (pkg.dependencies !== undefined && Object.keys(pkg.dependencies).some((k) => k.includes('dsh-code-graph')))
                    return true;
            }
            catch { /* 跳过无法解析的 profile */ }
        }
    }
    catch {
        return true;
    }
    try {
        const reg = JSON.parse(readFileSync(join(dshHome, 'super-injector', 'registry.json'), 'utf8'));
        if (Array.isArray(reg) && reg.some((row) => typeof row?.name === 'string' && row.name.includes('dsh-code-graph')))
            return true;
    }
    catch { /* 无 registry 视为未注册 */ }
    return false;
}
export function apply(ctx, config) {
    const stateFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-code-graph', 'state.json');
    const engineOpts = () => ({
        bin: expandHome(config.bin),
        defaultMode: config.defaultMode,
        fresh: config.fresh,
        freshThrottleSec: config.freshThrottleSec,
        maxRows: config.maxRows,
        branchIndex: config.branchIndex,
        maxBranchProjects: config.maxBranchProjects,
        branchIndexMaxDbBytes: config.branchIndexMaxDbBytes,
        stateFile: stateFile(),
    });
    // ── 1) 唯一工具：codegraph 分发器（schema 精简：一个工具扛全部操作）─────────
    ctx.effect(() => ctx.tools.register(defineTool({
        name: 'codegraph',
        description: '本地代码图：索引/符号检索/调用链/影响面/路径/架构。跨文件代码问题优先用它，替代盲 grep。',
        parameters: {
            op: { type: 'string', required: true, description: 'projects|status|index|changes|query|callers|callees|impact|trace|architecture|snippet' },
            repo_path: { type: 'string', description: '仓库绝对路径（index 必需；其余可省）' },
            project: { type: 'string', description: '项目名（省略时按 repo_path 或唯一已索引项目解析）' },
            branch: { type: 'string', description: '分支（缺省=当前检出分支；显式指定仅查已建索引的分支）' },
            query: { type: 'string', description: 'query：关键词/符号名（BM25 结构加权）' },
            name: { type: 'string', description: 'callers/callees/impact/trace/snippet：函数名' },
            mode: { type: 'string', description: 'index: fast|moderate|full；trace: calls|data_flow|cross_service' },
            depth: { type: 'number', description: 'impact/trace 深度（impact 默认 3，上限 8）' },
            max_rows: { type: 'number', description: '返回行数上限' },
            path: { type: 'string', description: 'architecture：目录前缀过滤' },
            since: { type: 'string', description: 'changes：git ref（如 HEAD~5、v0.5.0）' },
            fresh: { type: 'boolean', description: '查询前保鲜门控（默认开）' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
        },
        execute: async (rawArgs, toolCtx) => {
            const args = rawArgs;
            const result = await dispatchOp(args, { opts: engineOpts(), signal: toolCtx?.signal });
            refreshProjects(engineOpts()).catch(() => undefined);
            return JSON.parse(JSON.stringify(result));
        },
        timeoutMs: 620_000,
    })), 'dsh-code-graph: codegraph tool');
    // ── 2) /codegraph 命令：人侧 100% 确定性入口 ────────────────────────────────
    if (ctx.commands) {
        ctx.effect(() => ctx.commands.register({
            name: 'codegraph',
            description: '代码图：/codegraph 查看已索引项目；/codegraph <repo路径> [fast|moderate|full] 建索引',
            input: { hint: '[<repo路径>] [fast|moderate|full]', images: false },
            handler: async (invocation) => {
                const raw = (invocation.rawInput ?? '').trim();
                if (!raw) {
                    const names = projectCache.names.length ? projectCache.names : await refreshProjects(engineOpts());
                    if (!names.length)
                        return { kind: 'success', text: '代码图：暂无已索引项目。用 /codegraph <repo绝对路径> 建索引。' };
                    const lines = ['代码图已索引项目：'];
                    for (const n of names) {
                        try {
                            const st = await runEngine(engineOpts(), 'index_status', { project: n }, 30_000);
                            const d = st.data ?? {};
                            const br = d.branch ?? d.git?.branch;
                            lines.push('- ' + n + '：' + (d.status ?? '?') + '，' + (d.nodes ?? '?') + ' 节点 / ' + (d.edges ?? '?') + ' 边' + (br ? '，branch=' + br : '') + '，root=' + (d.root_path ?? '?'));
                        }
                        catch (e) {
                            lines.push('- ' + n + '：状态查询失败（' + String(e.message).slice(0, 120) + '）');
                        }
                    }
                    return { kind: 'success', text: lines.join('\n') };
                }
                const parts = raw.split(/\s+/);
                const repo = parts[0];
                const mode = parts[1] ?? config.defaultMode;
                if (!existsSync(repo))
                    return { kind: 'error', text: '路径不存在: ' + repo };
                const r = await dispatchOp({ op: 'index', repo_path: repo, mode }, { opts: engineOpts() });
                return { kind: 'success', text: '索引完成：' + JSON.stringify(r) };
            },
        }), 'dsh-code-graph: /codegraph command');
    }
    else {
        ctx.logger?.warn?.('[dsh-code-graph] commands service missing — /codegraph disabled');
    }
    // ── 3) 条件提示 section：仅当存在已索引项目时注入 2 行（schema 外零成本引导）──
    if (ctx.systemPrompt) {
        ctx.effect(() => ctx.systemPrompt.section({
            name: 'dsh-code-graph',
            order: 50,
            text: () => {
                if (!config.hint || !projectCache.names.length)
                    return '';
                return [
                    '[dsh-code-graph] 已索引代码图可用（' + projectCache.names.slice(0, 3).join(', ') + (projectCache.names.length > 3 ? ' 等' : '') + '）：分支切换自动跟随（查询对应当前检出分支；branch 参数查已建索引分支）。',
                    '凡需要读代码（谁调用/影响面/数据流/架构/检索实现），一律先用 codegraph 查询（query/callers/callees/impact/trace/architecture）；grep 仅在项目无法使用代码图时回退（未先调 codegraph 的代码 grep 会被内置门禁拒绝）；只有主 agent 可执行 op=index。',
                ].join('\n');
            },
        }), 'dsh-code-graph: prompt section');
    }
    // ── 3.5) 100% 强制层：agent/pre-step 钩子（instruction-hint 同款追加形态）────
    // - 会话首步（且已有索引项目）：追加 codegraph-first 规则消息；
    // - 会话内直接读代码工具用 ≥2 次而 codegraph 0 次：追加定向提醒（每会话一次）；
    // - 追加形态与 source.kind 完全对齐 anchored-standard/instruction-hint 实测约定；
    // - 任何钩子异常都静默跳过（绝不伤害会话），glm 预设无 gate、追加直达。
    const hinted = new Set();
    const nudged = new Set();
    const CODE_READ_TOOLS = new Set(['read', 'grep', 'glob']);
    const toolNameOf = (e) => String(e?.tool ?? e?.name ?? e?.payload?.name ?? e?.data?.name ?? '');
    ctx.effect(() => ctx.on('agent/pre-step', async ({ agent }, next) => {
        const decision = await next();
        try {
            const session = agent?.session;
            if (session === undefined || !projectCache.names.length)
                return decision;
            const events = Array.isArray(session.events) ? session.events : [];
            const toolCalls = events.filter((e) => e?.type === 'tool/call');
            const reads = toolCalls.filter((e) => CODE_READ_TOOLS.has(toolNameOf(e))).length;
            const cgCalls = toolCalls.filter((e) => toolNameOf(e) === 'codegraph').length;
            let text = null;
            // 客户端 conversation reducer 要求 user/message id 唯一（重复 start Match 会让 Web 会话历史加载失败）；
            // hinted/nudged 是进程级 Set，服务重启即清零 —— 必须再扫一遍会话事件防跨重启重复注入。
            const alreadyHinted = events.some((e) => e?.type === 'user/message' &&
                (e?.data?.source?.kind === 'codegraph-hint' || (typeof e?.data?.id === 'string' && e.data.id.startsWith('codegraph-hint-'))));
            if (!hinted.has(session.id) && !alreadyHinted) {
                hinted.add(session.id);
                text = '[dsh-code-graph] 已索引代码图可用（' + projectCache.names.slice(0, 3).join(', ') + (projectCache.names.length > 3 ? ' 等' : '') + '）。凡需要读代码/跨文件理解，必须先用 codegraph 工具（op=query/callers/callees/impact/trace/architecture）获取结构化上下文；grep 仅在项目无法使用代码图时回退（未先调 codegraph 的代码 grep 会被内置门禁拒绝）；op=index 仅主 agent 可执行。';
            }
            else if (reads >= 2 && cgCalls === 0 && !nudged.has(session.id)) {
                nudged.add(session.id);
                text = '[dsh-code-graph] 本会话已直接读取代码 ' + reads + ' 次而未用代码图。若任务涉及跨文件理解，改用 codegraph（op=query/callers/impact）更准更快；纯单文件查看可继续用 read。';
            }
            if (text === null)
                return decision;
            return {
                ...decision,
                messages: [...(Array.isArray(decision?.messages) ? decision.messages : []), {
                        id: 'codegraph-hint-' + session.id + '-' + reads + '-' + cgCalls + '-' + Date.now().toString(36),
                        role: 'user',
                        content: [{ type: 'text', text }],
                        source: { kind: 'codegraph-hint', form: 'hint' },
                    }],
            };
        }
        catch {
            // 钩子 bug 绝不伤害会话
            return decision;
        }
    }, { prepend: true }), 'dsh-code-graph: pre-step enforcer');
    // ── 3.6) 硬门禁：tools/pre-execute 拦截 grep（config.gate，默认开）──────────
    // 读代码必须先用 codegraph；grep 仅限「该会话视界内 codegraph 不可用」的回退。
    // - deny 前查 scoped 可见性（ctx.tools.get('codegraph', agent)）：视界内没有
    //   codegraph 的会话自动获得 grep 回退，避免「无法自证不可用」死锁；
    // - 与 3.5 软提示构成双层：pre-step 追加引导，pre-execute 硬拦截；
    // - 门禁自身异常一律放行（fail-open，绝不阻塞工具链）；审计落 ~/.dsh/codegraph-gate.log。
    if (config.gate) {
        const seenCg = new WeakSet();
        const gateLog = (o) => {
            try {
                const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codegraph-gate.log');
                const line = JSON.stringify(o) + '\n';
                appendFileSync(file, line);
                try {
                    if (statSync(file).size > 262144)
                        writeFileSync(file, line);
                }
                catch { /* 轮转失败忽略 */ }
            }
            catch { /* 审计失败不影响主流程 */ }
        };
        const GATE_REJECT = '[dsh-code-graph] 全局规则（内置门禁）：需要读代码时必须先用 codegraph 工具（op=query/callers/callees/impact/trace/architecture），禁止直接用 grep。仅当项目无法使用代码图时才允许 grep 回退：请先调用一次 codegraph（如 op=query，repo_path=目标目录；未索引项目由主 agent op=index）确认不可用，之后重试 grep 即放行。';
        const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|java|kt|kts|go|rs|c|h|cpp|hpp|cc|hh|swift|m|mm|scala|rb|php|cs|dart|vue|svelte|astro|gradle|groovy|bzl|lua|r|jl|ex|exs|erl|hs|ml|mli|clj|cljs|sql|sh|bash|zsh|ps1|psm1|bat|cmd)$/i;
        const CODE_IN_GLOB = /\b(ts|tsx|js|jsx|mjs|cjs|py|java|kt|kts|go|rs|c|cpp|hpp|cc|swift|m|mm|scala|rb|php|cs|dart|vue|svelte|gradle|groovy|lua|sql|sh|bash|hs|ex|clj|erl|ml|bzl|ps1|bat|cmd)\b/i;
        const DOC_IN_GLOB = /\.(md|markdown|mdx|txt|log|csv|tsv|ya?ml|toml|ini|cfg|conf|env|html?|css|scss|less|xml|json|jsonc|json5|png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?)$/i;
        const REPO_MARKERS = ['package.json', 'tsconfig.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'requirements.txt', 'CMakeLists.txt', 'Makefile', '.git', 'pubspec.yaml'];
        const argsOf = (e) => (e && (e.args ?? e.input ?? e.arguments ?? e.params)) || {};
        const isCodeTargeted = (a) => {
            const p = typeof a?.path === 'string' ? a.path : '';
            const inc = typeof a?.include === 'string' ? a.include : '';
            if (inc) {
                if (CODE_IN_GLOB.test(inc))
                    return true;
                if (DOC_IN_GLOB.test(inc))
                    return false;
            }
            if (!p)
                return true; // 缺省 path = 会话工作区（通常是代码仓库）：从严
            if (CODE_EXT.test(p))
                return true;
            try {
                if (statSync(p).isDirectory())
                    return REPO_MARKERS.some((m) => existsSync(join(p, m)));
            }
            catch { /* 路径不存在/glob 形态：放行 */ }
            return false;
        };
        ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
            try {
                const t = String(exec?.name ?? exec?.tool ?? '');
                if (t === 'codegraph') {
                    if (exec?.agent)
                        seenCg.add(exec.agent);
                    gateLog({ t: Date.now(), ev: 'codegraph' });
                    return next();
                }
                if (t !== 'grep')
                    return next();
                const a = argsOf(exec);
                if (!isCodeTargeted(a)) {
                    gateLog({ t: Date.now(), ev: 'grep-allow-noncode', a });
                    return next();
                }
                if (!exec?.agent) {
                    gateLog({ t: Date.now(), ev: 'grep-allow-noagent' });
                    return next();
                }
                if (seenCg.has(exec.agent)) {
                    gateLog({ t: Date.now(), ev: 'grep-allow-after-codegraph', a });
                    return next();
                }
                if (!ctx.tools.get?.('codegraph', exec.agent)) {
                    gateLog({ t: Date.now(), ev: 'grep-allow-no-codegraph-tool', a });
                    return next();
                }
                gateLog({ t: Date.now(), ev: 'deny', a });
                return { kind: 'deny', reason: GATE_REJECT };
            }
            catch (e) {
                gateLog({ t: Date.now(), ev: 'error', msg: String(e) });
                return next();
            }
        }), 'dsh-code-graph: pre-execute grep gate');
    }
    // ── 4) skill 落盘：<DSH_HOME>/skills/dsh-code-graph.md，卸载即删 ────────────
    if (config.skill) {
        ctx.effect(() => {
            const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
            const file = join(home, 'skills', 'dsh-code-graph.md');
            try {
                let existing = '';
                try {
                    existing = readFileSync(file, 'utf8');
                }
                catch { /* 不存在 */ }
                if (existing !== SKILL_MARKDOWN) {
                    mkdirSync(join(home, 'skills'), { recursive: true });
                    writeFileSync(file, SKILL_MARKDOWN);
                }
            }
            catch (e) {
                ctx.logger?.warn?.('[dsh-code-graph] skill 落盘失败: ' + String(e.message));
            }
            return () => {
                // 卸载清理的时序陷阱（2026-09-14 实测：14:08:01 本文件被删而插件仍是 active）：
                // 重装配是「新代先 apply、旧代后 dispose」，旧代立即删除会删掉仍在用的技能。
                // 延迟一拍 + 二次校验，只有确属卸载才删；内容被人改过也一律保留。
                const timer = setTimeout(() => {
                    try {
                        if (stillInstalled(home))
                            return;
                        if (!existsSync(file))
                            return;
                        if (readFileSync(file, 'utf8') !== SKILL_MARKDOWN)
                            return;
                        rmSync(file);
                    }
                    catch { /* 清理失败不阻断卸载 */ }
                }, 1500);
                if (typeof timer.unref === 'function')
                    timer.unref();
            };
        }, 'dsh-code-graph: skill file');
    }
    // ── 5) 卸载零残留：清理保鲜签名状态文件（缓存性质，重装后首查自动重采纳）────
    ctx.effect(() => {
        const file = stateFile();
        return () => {
            try {
                rmSync(file, { force: true });
            }
            catch { /* 清理失败不阻断卸载 */ }
        };
    }, 'dsh-code-graph: state cleanup');
    // 启动即惰性刷新一次项目缓存（fail-soft：引擎缺失不影响装载）
    refreshProjects(engineOpts()).catch(() => undefined);
}
function expandHome(p) {
    return p.startsWith('~') ? homedir() + p.slice(1) : p;
}
//# sourceMappingURL=index.js.map