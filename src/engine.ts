/**
 * dsh-code-graph 引擎包装层。
 *
 * 后端 = 本机 codebase-memory-mcp 二进制的 CLI 模式（cli <tool>，JSON 走 stdin）：
 * - 不注册任何会话级 MCP、无常驻连接：每次调用按需 spawn，用完即走；
 * - stdout 为纯 JSON（引擎日志走 stderr，实测 v0.9.0）；
 * - fail loud：所有失败点名工具与原因，绝不静默吞错。
 *
 * 分支索引层（branch-aware index，2026-09-17 迭代）：
 * - 项目名 = 路径__分支（引擎 index_repository --name 覆盖派生名，一分支一库；@ 会被引擎
 *   规范化成 - 故用 __ 作分隔符，spike 实测）；
 * - multi（常规仓）：每分支一份索引图 + LRU 上限；切回已访问分支零重索引；
 * - single（大仓，DB 超 branchIndexMaxDbBytes）：滚动单索引——每次使用核对当前
 *   检出分支 vs 注册表预期分支，不一致即删旧建新（用户拍板：稳态恒 1 份 DB）；
 * - legacy 采纳：升级零迁移——存量 path-slug 项目签名（HEAD+脏树）与实时态全等
 *   时直接别名给当前分支，不重建；
 * - 降级：branchIndex=false / 非 git 目录 / 引擎异常 → 回退单索引跟随行为（fail-open）。
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const pExecFile = promisify(execFile)

export interface EngineOptions {
  bin: string
  defaultMode: string
  fresh: boolean
  freshThrottleSec: number
  maxRows: number
  /** 分支索引层总开关：false = 整体回退单索引跟随行为（legacy 路径派生名） */
  branchIndex: boolean
  /** multi 模式每仓库分支项目上限（LRU，含当前分支；legacy path-slug 项目不计入） */
  maxBranchProjects: number
  /** 项目 DB 超过该字节数 → single（大仓滚动单索引）模式 */
  branchIndexMaxDbBytes: number
  /** 插件侧索引签名持久化文件（head_sha 实时态不可信，需自记快照） */
  stateFile?: string
}

export function resolveBin(bin: string): string {
  const p = bin.startsWith('~') ? joinHome(bin) : bin
  if (!existsSync(p)) {
    throw new Error('[dsh-code-graph] 引擎不存在: ' + p + '（安装: pipx/curl 见 README；或用 config 改 bin 路径）')
  }
  return p
}

function joinHome(p: string): string {
  return homedir() + p.slice(1)
}

export interface RunResult {
  ok: boolean
  data: any
  stderrTail: string
}

/** 单次 CLI 调用：stdin 传 JSON args（非弃用通道），stdout 解析 JSON。 */
export async function runEngine(
  opts: EngineOptions,
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RunResult> {
  const bin = resolveBin(opts.bin)
  return await new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, ['cli', tool], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // HOME 兜底：引擎以 HOME 推导缓存根（~/.cache/codebase-memory-mcp），
      // 沙箱/HOME 缺失时会流落到 TMPDIR，造成图库分叉（实测踩坑）。
      env: { ...process.env, HOME: process.env.HOME ?? homedir() },
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; child.kill('SIGKILL'); reject(new Error('[dsh-code-graph] 引擎调用超时(' + timeoutMs + 'ms): ' + tool)) }
    }, timeoutMs)
    const onAbort = () => { if (!done) { done = true; clearTimeout(timer); child.kill('SIGTERM'); reject(new Error('[dsh-code-graph] 引擎调用被取消: ' + tool)) } }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', (err) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort)
      reject(new Error('[dsh-code-graph] 引擎启动失败(' + bin + '): ' + err.message))
    })
    child.on('close', (code) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort)
      const stderrTail = stderr.split('\n').filter(Boolean).slice(-4).join(' | ')
      if (code !== 0) {
        reject(new Error('[dsh-code-graph] 引擎工具失败: ' + tool + ' (exit ' + code + ') ' + stderrTail.slice(0, 400)))
        return
      }
      const text = stdout.trim()
      const start = text.indexOf('{')
      const startArr = text.indexOf('[')
      const s = startArr !== -1 && (start === -1 || startArr < start) ? startArr : start
      if (s === -1) {
        reject(new Error('[dsh-code-graph] 引擎输出非 JSON: ' + tool + ' → ' + text.slice(0, 200)))
        return
      }
      try {
        resolve({ ok: true, data: JSON.parse(text.slice(s)), stderrTail })
      } catch (e) {
        reject(new Error('[dsh-code-graph] 引擎输出解析失败: ' + tool + ' → ' + text.slice(0, 200)))
      }
    })
    child.stdin.write(JSON.stringify(args ?? {}))
    child.stdin.end()
  })
}

// ── list_projects TTL 缓存：分支解析每次都要项目清单，避免 spawn 风暴 ─────────
let lpCache: { at: number; projects: any[] } | null = null
const LP_TTL_MS = 5_000

function invalidateListCache(): void { lpCache = null }

export async function listProjects(opts: EngineOptions, force = false): Promise<any[]> {
  if (!force && lpCache && Date.now() - lpCache.at < LP_TTL_MS) return lpCache.projects
  const r = await runEngine(opts, 'list_projects', {}, 30_000)
  const projects: any[] = r.data?.projects ?? []
  lpCache = { at: Date.now(), projects }
  return projects
}

// ── 索引单飞：同一 canonical repo + 目标名同时最多一个 index ─────────────────
const inflight = new Map<string, Promise<any>>()

export async function indexSingleFlight(
  opts: EngineOptions,
  repoPath: string,
  mode: string,
  timeoutMs: number,
  name?: string,
): Promise<any> {
  const key = canonPath(repoPath) + '|' + (name ?? '')
  const existing = inflight.get(key)
  if (existing) return await existing
  const p = (async () => {
    try {
      const args: Record<string, unknown> = { repo_path: repoPath, mode }
      // --name 覆盖引擎派生名：分支项目 = 路径@分支；legacy 项目传原名 = 无操作覆盖
      if (name) args.name = name
      return await runEngine(opts, 'index_repository', args, timeoutMs)
    } finally {
      inflight.delete(key)
      invalidateListCache()
    }
  })()
  inflight.set(key, p)
  return await p
}

/** delete_project 包装：删除成功返回 true；失败 fail-open（由淘汰/清理方决定是否继续）。 */
export async function deleteProject(opts: EngineOptions, project: string): Promise<boolean> {
  try {
    await runEngine(opts, 'delete_project', { project }, 30_000)
    invalidateListCache()
    return true
  } catch {
    invalidateListCache()
    return false
  }
}

// ── 持久化状态：签名快照 + 分支注册表（同文件，损坏即空态）──────────────────
export interface AliasEntry { project: string; at: number }
export interface RepoReg {
  /** multi 模式：原始分支名 → 分支项目 */
  alias?: Record<string, AliasEntry>
  /** single 模式：预期分支槽位（稳态每仓只留这一份分支索引） */
  single?: { branch: string; project: string; at: number }
}

const sigStore = new Map<string, { sig: string; at: number }>()
const regStore: Record<string, RepoReg> = {}
let stateLoaded = false

function loadState(stateFile?: string): void {
  if (stateLoaded || !stateFile) return
  stateLoaded = true
  try {
    if (existsSync(stateFile)) {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, any>
      // 旧格式 = 平铺 {project: {sig, at}}；新格式 = {sigs, repos}
      const sigs: Record<string, { sig: string; at: number }> = parsed?.sigs && typeof parsed.sigs === 'object' ? parsed.sigs : parsed
      for (const [k, v] of Object.entries(sigs ?? {})) {
        if (v && typeof v === 'object' && typeof (v as any).sig === 'string') sigStore.set(k, v as { sig: string; at: number })
      }
      const repos = parsed?.sigs ? parsed.repos : undefined
      for (const [k, v] of Object.entries(repos ?? {})) {
        if (v && typeof v === 'object') regStore[k] = v as RepoReg
      }
    }
  } catch { /* 状态文件损坏：当作空状态 */ }
}

function saveState(stateFile?: string): void {
  if (!stateFile) return
  try {
    mkdirSync(dirname(stateFile), { recursive: true })
    writeFileSync(stateFile, JSON.stringify({ sigs: Object.fromEntries(sigStore), repos: regStore }))
  } catch { /* 持久化失败不阻断：降级为进程内记忆 */ }
}

async function git(root: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await pExecFile('git', ['-C', root, ...args], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
  return stdout.trim()
}

async function liveSig(root: string): Promise<{ sig: string; head: string; dirty: boolean }> {
  const head = await git(root, ['rev-parse', 'HEAD'])
  const dirty = (await git(root, ['status', '--porcelain'])).length > 0
  return { sig: head + (dirty ? '+dirty' : '+clean'), head, dirty }
}

/** 索引成功后记录该项目的签名快照（op=index 与自动重索引共用）。 */
export async function recordSig(opts: EngineOptions, project: string, root: string, stateFile?: string): Promise<void> {
  try {
    const s = await liveSig(root)
    loadState(stateFile)
    sigStore.set(project, { sig: s.sig, at: Date.now() })
    saveState(stateFile)
  } catch { /* 非 git 仓库：无签名可记 */ }
}

export interface FreshInfo {
  checked: boolean
  drift: boolean
  reindexed: boolean
  headSha?: string
  dirty?: boolean
  note?: string
}

/** 查询前保鲜：实时态 vs 插件侧索引快照，漂移则 fast 增量重索引（窗口节流防抖）。 */
export async function ensureFresh(
  opts: EngineOptions,
  project: string,
  timeoutMs: number,
): Promise<FreshInfo> {
  if (!opts.fresh) return { checked: false, drift: false, reindexed: false, note: 'fresh=off' }
  const st = await runEngine(opts, 'index_status', { project }, 30_000)
  const root: string | undefined = st.data?.root_path
  if (!root || !existsSync(root)) return { checked: false, drift: false, reindexed: false, note: 'no root_path' }
  let live: { sig: string; head: string; dirty: boolean }
  try {
    live = await liveSig(root)
  } catch (e) {
    return { checked: false, drift: false, reindexed: false, note: 'git unavailable: ' + String((e as Error).message).slice(0, 120) }
  }
  loadState(opts.stateFile)
  const snapshot = sigStore.get(project)
  if (!snapshot) {
    // 无快照（老项目/外部索引）：记当前态，本轮不重索引（避免首查全量重建）
    sigStore.set(project, { sig: live.sig, at: Date.now() })
    saveState(opts.stateFile)
    return { checked: true, drift: false, reindexed: false, headSha: live.head, dirty: live.dirty, note: 'snapshot adopted' }
  }
  const now = Date.now()
  if (snapshot.sig === live.sig && now - snapshot.at < opts.freshThrottleSec * 1000) {
    return { checked: true, drift: false, reindexed: false, headSha: live.head, dirty: live.dirty, note: 'throttled' }
  }
  if (snapshot.sig === live.sig) {
    // 过节流窗口的命中：touch 时间戳（multi 模式 LRU 淘汰的 recency 依据）
    sigStore.set(project, { sig: live.sig, at: now })
    saveState(opts.stateFile)
    return { checked: true, drift: false, reindexed: false, headSha: live.head, dirty: live.dirty }
  }
  // 漂移重索引必须带项目名（--name）：分支项目否则会被引擎重派生路径名建错库
  await indexSingleFlight(opts, root, opts.defaultMode, timeoutMs, project)
  sigStore.set(project, { sig: live.sig, at: now })
  saveState(opts.stateFile)
  return { checked: true, drift: true, reindexed: true, headSha: live.head, dirty: live.dirty }
}

// ── 分支解析：multi（常规仓每分支一库）/ single（大仓滚动单索引）──────────────

export interface BranchResolution {
  project: string
  rootPath?: string
  /** 目标分支（当前检出或显式指定；非 git 目录为 undefined） */
  branch?: string
  /** 分支层模式：off = branchIndex 关闭/非 git */
  mode: 'multi' | 'single' | 'off'
  /** 目标是否当前检出分支（决定能否做保鲜比对） */
  isCurrent: boolean
  /** legacy 项目被采纳为当前分支索引（零重建） */
  adopted?: boolean
  /** 本次解析实际执行了索引（新建或显式 index 的增量） */
  built?: boolean
  /** single 模式发生了删旧建新切换 */
  switched?: boolean
  /** 本次被删除的项目（淘汰/单槽清理，fail-open 只记成功者） */
  evicted?: string[]
  note?: string
  raw?: any
}

const BUILD_TIMEOUT = 600_000

export function canonPath(p: string): string {
  try { return realpathSync(p) } catch { return p.replace(/\/+$/, '') }
}

export function branchSlug(b: string): string {
  return b.replace(/[^A-Za-z0-9._-]+/g, '-')
}

/** 分支项目名：路径 slug + '__' + 分支 slug（引擎把 @ 规范化为 -，__ 原样保留——spike 实测）。 */
export function branchProjectName(rootPath: string, branch: string): string {
  return rootPath.replace(/^\//, '').replace(/\//g, '-') + '__' + branchSlug(branch)
}

/** 当前检出分支；detached HEAD → detached-<sha7>；非 git 目录 → null。 */
export async function currentBranch(root: string): Promise<string | null> {
  try {
    const b = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    if (b && b !== 'HEAD') return b
    const sha = await git(root, ['rev-parse', 'HEAD'])
    return 'detached-' + sha.slice(0, 7)
  } catch { return null }
}

/** multi 模式 LRU 淘汰：分支项目总数（含 keep）超上限时按最久未用删除。 */
async function evictMulti(opts: EngineOptions, canon: string, keep: string): Promise<string[]> {
  const max = Math.max(1, opts.maxBranchProjects)
  const matching = (await listProjects(opts, true)).filter((p) => canonPath(p.root_path ?? '') === canon)
  const reg = regStore[canon]
  const candidates = matching
    .map((p) => String(p.name ?? p.project))
    .filter((n) => n.includes('__') && n !== keep)
    .sort((x, y) => (sigStore.get(x)?.at ?? 0) - (sigStore.get(y)?.at ?? 0))
  const evicted: string[] = []
  let total = candidates.length + 1
  for (const n of candidates) {
    if (total <= max) break
    if (await deleteProject(opts, n)) {
      evicted.push(n)
      total--
      if (reg?.alias) {
        for (const [b, v] of Object.entries(reg.alias)) {
          if (v.project === n) delete reg.alias[b]
        }
      }
    } else {
      break // fail-open：删除失败即停，绝不阻塞查询
    }
  }
  return evicted
}

/** single 模式单槽清理：删除该仓 keep 之外的全部索引项目（含 orphan legacy）。 */
async function pruneSingle(opts: EngineOptions, canon: string, keep: string): Promise<string[]> {
  const matching = (await listProjects(opts, true)).filter((p) => canonPath(p.root_path ?? '') === canon)
  const removed: string[] = []
  for (const p of matching) {
    const n = String(p.name ?? p.project)
    if (n === keep) continue
    if (await deleteProject(opts, n)) removed.push(n)
  }
  return removed
}

/** 分支注册表清单（op=status 用）：multi = 分支项目列表；single = 预期分支槽位。 */
export async function branchInventory(opts: EngineOptions, canon: string): Promise<Record<string, unknown> | undefined> {
  loadState(opts.stateFile)
  const reg = regStore[canon]
  if (!reg || (!reg.alias && !reg.single)) return undefined
  const lp = await listProjects(opts)
  const names = new Set(lp.map((p) => String(p.name ?? p.project)))
  if (reg.single) {
    return {
      mode: 'single',
      expectedBranch: reg.single.branch,
      project: reg.single.project,
      at: reg.single.at,
      present: names.has(reg.single.project),
    }
  }
  const list = Object.entries(reg.alias ?? {})
    .map(([b, v]) => ({ branch: b, project: v.project, at: v.at, present: names.has(v.project) }))
    .sort((x, y) => y.at - x.at)
  return { mode: 'multi', branches: list }
}

/**
 * 分支感知项目解析。
 *
 * - 显式 project / branchIndex 关闭 / 非 git 目录 → 单项目直取（legacy 行为）；
 * - multi：alias 命中 → legacy 签名采纳 → 建 @分支 项目（LRU 淘汰）；
 * - single：预期分支命中 → 删旧建新（用户拍板：每次使用核对分支，不一致删旧建新）；
 * - 显式 branch ≠ 当前检出：只读已建索引（不保鲜——工作树不是该分支），无则 fail-loud。
 */
export async function resolveProjectBranchAware(
  opts: EngineOptions,
  a: { repo_path?: string; project?: string; branch?: string },
  o?: { forIndex?: boolean },
): Promise<BranchResolution> {
  // 1) 显式 project：分支层不介入
  if (a.project) {
    const lp = await listProjects(opts)
    const hit = lp.find((p) => (p.name ?? p.project) === a.project)
    return { project: a.project, rootPath: hit?.root_path, mode: 'off', isCurrent: true }
  }
  // 2) 无 repo_path：唯一项目直取，否则 loud
  if (!a.repo_path) {
    const lp = await listProjects(opts)
    if (lp.length === 1) {
      return { project: lp[0].name ?? lp[0].project, rootPath: lp[0].root_path, mode: 'off', isCurrent: true }
    }
    throw new Error('[dsh-code-graph] 无法定位项目: 传 project 或 repo_path。已索引: ' + (lp.map((p) => p.name ?? p.project).join(', ') || '(无)'))
  }
  const canon = canonPath(a.repo_path)
  let matching = (await listProjects(opts)).filter((p) => canonPath(p.root_path ?? '') === canon)
  // 3) 仓库从未索引：仅 op=index 允许创建
  if (!matching.length) {
    if (!o?.forIndex) {
      throw new Error('[dsh-code-graph] 仓库未索引: ' + canon + '（先调 op=index；已索引项目: ' + (await listProjects(opts)).map((p) => p.name ?? p.project).join(', ') + '）')
    }
    const branch = opts.branchIndex ? await currentBranch(canon) : null
    if (!branch) {
      const built = await indexSingleFlight(opts, a.repo_path, opts.defaultMode, BUILD_TIMEOUT)
      const name = built.data?.project
      if (name) await recordSig(opts, String(name), canon, opts.stateFile)
      return { project: String(name ?? ''), rootPath: canon, mode: 'off', isCurrent: true, built: true, raw: built.data }
    }
    const name = branchProjectName(canon, branch)
    const built = await indexSingleFlight(opts, canon, opts.defaultMode, BUILD_TIMEOUT, name)
    await recordSig(opts, name, canon, opts.stateFile)
    matching = (await listProjects(opts, true)).filter((p) => canonPath(p.root_path ?? '') === canon)
    const dbBytes = Math.max(0, ...matching.map((p) => Number(p.size_bytes ?? 0)))
    loadState(opts.stateFile)
    const reg: RepoReg = regStore[canon] ?? (regStore[canon] = {})
    if (dbBytes > opts.branchIndexMaxDbBytes) {
      reg.single = { branch, project: name, at: Date.now() }
      const cleaned = await pruneSingle(opts, canon, name)
      saveState(opts.stateFile)
      return { project: name, rootPath: canon, branch, mode: 'single', isCurrent: true, built: true, evicted: cleaned.length ? cleaned : undefined, raw: built.data }
    }
    reg.alias ??= {}
    reg.alias[branch] = { project: name, at: Date.now() }
    saveState(opts.stateFile)
    return { project: name, rootPath: canon, branch, mode: 'multi', isCurrent: true, built: true, raw: built.data }
  }
  // 4) branchIndex 关闭：旧行为（root_path 匹配，优先无 @ 的 legacy 项目）
  if (!opts.branchIndex) {
    const hit = matching.find((p) => !String(p.name ?? '').includes('__')) ?? matching[0]
    return { project: String(hit.name ?? hit.project), rootPath: hit.root_path, mode: 'off', isCurrent: true }
  }
  // 5) 非 git 目录：无分支层
  const branch = await currentBranch(canon)
  if (!branch) {
    const hit = matching[0]
    return { project: String(hit.name ?? hit.project), rootPath: hit.root_path, mode: 'off', isCurrent: true }
  }
  loadState(opts.stateFile)
  const reg: RepoReg = regStore[canon] ?? (regStore[canon] = {})
  const dbBytes = Math.max(0, ...matching.map((p) => Number(p.size_bytes ?? 0)))
  const mode = dbBytes > opts.branchIndexMaxDbBytes ? 'single' : 'multi'
  const targetBranch = a.branch ?? branch
  const byName = new Map(matching.map((p) => [String(p.name ?? p.project), p]))

  // 6) 显式 branch ≠ 当前检出：只读该分支已建索引（不做保鲜——工作树不是该分支）
  if (targetBranch !== branch) {
    if (o?.forIndex) {
      throw new Error('[dsh-code-graph] op=index 只能索引当前检出分支（当前 ' + branch + '，请求 ' + targetBranch + '）；请先 checkout 到目标分支。')
    }
    if (mode === 'single') {
      const e = reg.single
      throw new Error('[dsh-code-graph] 大仓单槽模式：仅预期分支 ' + (e?.branch ?? '(未建)') + ' 有索引（其余已按设计删除）；查 ' + targetBranch + ' 请先 checkout。')
    }
    const hit = reg.alias?.[targetBranch]
    if (hit && byName.has(hit.project)) {
      return { project: hit.project, rootPath: byName.get(hit.project)!.root_path, branch: targetBranch, mode, isCurrent: false }
    }
    const avail = Object.entries(reg.alias ?? {}).map(([b, v]) => b + (byName.has(v.project) ? '' : '(缺失)'))
    throw new Error('[dsh-code-graph] 分支 ' + targetBranch + ' 尚无索引图（仅已访问过的分支可查）。可用: ' + (avail.join(', ') || '(无)'))
  }

  // 7) 当前检出分支
  const live = await liveSig(canon)
  if (mode === 'multi') {
    const name = branchProjectName(canon, branch)
    const hit = reg.alias?.[branch]
    if (hit && byName.has(hit.project)) {
      if (o?.forIndex) {
        const built = await indexSingleFlight(opts, canon, opts.defaultMode, BUILD_TIMEOUT, hit.project)
        await recordSig(opts, hit.project, canon, opts.stateFile)
        return { project: hit.project, rootPath: canon, branch, mode, isCurrent: true, built: true, raw: built.data }
      }
      return { project: hit.project, rootPath: byName.get(hit.project)!.root_path, branch, mode, isCurrent: true }
    }
    // legacy 采纳：签名全等（verified）或无快照（unverified，对齐 ensureFresh 的 snapshot-adopted
    // 语义——热重载/升级后 state.json 被清，大仓首查不触发全量重建）→ 零重建
    const legacy = matching.find((p) => !String(p.name ?? '').includes('__'))
    const legacySig = legacy ? sigStore.get(String(legacy.name)) : undefined
    if (legacy && (!legacySig || legacySig.sig === live.sig)) {
      reg.alias ??= {}
      reg.alias[branch] = { project: String(legacy.name), at: Date.now() }
      saveState(opts.stateFile)
      if (o?.forIndex && !legacySig) {
        // 显式 op=index 且无快照：采纳后仍执行增量索引（用户明确要求索引）
        const built = await indexSingleFlight(opts, canon, opts.defaultMode, BUILD_TIMEOUT, String(legacy.name))
        await recordSig(opts, String(legacy.name), canon, opts.stateFile)
        return { project: String(legacy.name), rootPath: legacy.root_path, branch, mode, isCurrent: true, adopted: true, built: true, raw: built.data, note: 'legacy adopted (unverified) + reindexed' }
      }
      return { project: String(legacy.name), rootPath: legacy.root_path, branch, mode, isCurrent: true, adopted: true, note: legacySig ? 'legacy adopted: 存量索引与当前分支一致，未重建' : 'legacy adopted (unverified): 无签名快照，按当前分支采纳存量索引；若曾在其他分支建索引请 op=index 重建' }
    }
    // 建 @分支 项目
    const built = await indexSingleFlight(opts, canon, opts.defaultMode, BUILD_TIMEOUT, name)
    await recordSig(opts, name, canon, opts.stateFile)
    reg.alias ??= {}
    reg.alias[branch] = { project: name, at: Date.now() }
    const evicted = await evictMulti(opts, canon, name)
    saveState(opts.stateFile)
    return { project: name, rootPath: canon, branch, mode, isCurrent: true, built: true, evicted: evicted.length ? evicted : undefined, raw: built.data }
  }

  // 8) single：滚动单索引（用户拍板：每次使用核对分支，不一致删旧建新）
  const entry = reg.single
  const name = branchProjectName(canon, branch)
  if (entry && entry.branch === branch && byName.has(entry.project)) {
    if (o?.forIndex) {
      const built = await indexSingleFlight(opts, canon, opts.defaultMode, BUILD_TIMEOUT, entry.project)
      await recordSig(opts, entry.project, canon, opts.stateFile)
      return { project: entry.project, rootPath: canon, branch, mode, isCurrent: true, built: true, raw: built.data }
    }
    return { project: entry.project, rootPath: byName.get(entry.project)!.root_path, branch, mode, isCurrent: true }
  }
  if (!entry) {
    // 首次：legacy 采纳优先（verified 全等 或 unverified 无快照——升级/重载零重建）
    const legacy = matching.find((p) => !String(p.name ?? '').includes('__'))
    const legacySig = legacy ? sigStore.get(String(legacy.name)) : undefined
    if (legacy && (!legacySig || legacySig.sig === live.sig)) {
      reg.single = { branch, project: String(legacy.name), at: Date.now() }
      const cleaned = await pruneSingle(opts, canon, String(legacy.name))
      saveState(opts.stateFile)
      return { project: String(legacy.name), rootPath: legacy.root_path, branch, mode, isCurrent: true, adopted: true, evicted: cleaned.length ? cleaned : undefined, note: legacySig ? 'legacy adopted (single): 存量索引与当前分支一致，未重建' : 'legacy adopted (single, unverified): 按当前分支采纳存量索引' }
    }
  }
  // 删旧建新（含 orphan legacy 清理 → 稳态每仓 1 份）
  const removed: string[] = []
  if (entry?.project && byName.has(entry.project)) {
    if (await deleteProject(opts, entry.project)) removed.push(entry.project)
  }
  const built = await indexSingleFlight(opts, canon, opts.defaultMode, BUILD_TIMEOUT, name)
  await recordSig(opts, name, canon, opts.stateFile)
  reg.single = { branch, project: name, at: Date.now() }
  const cleaned = await pruneSingle(opts, canon, name)
  saveState(opts.stateFile)
  return { project: name, rootPath: canon, branch, mode, isCurrent: true, built: true, switched: true, evicted: [...removed, ...cleaned].length ? [...removed, ...cleaned] : undefined, raw: built.data }
}

// ── ripgrep 回落：图查询零命中时的保底（显式标注，绝不冒充图结果）────────────
export async function ripgrepFallback(
  root: string,
  query: string,
  signal?: AbortSignal,
): Promise<{ ran: boolean; engine?: string; reason?: string; hits: string[] }> {
  const tokens = query.split(/\s+/).filter((t) => t.length >= 2).slice(0, 4)
  if (!tokens.length) return { ran: false, reason: 'no usable tokens', hits: [] }
  const es = signal as any
  const toHits = (stdout: string): string[] => stdout.split('\n').filter(Boolean).slice(0, 24)
  // rg 优先
  try {
    const args = ['-n', '-i', '-m', '6', ...tokens.flatMap((t) => ['-e', t]), root]
    const { stdout } = await pExecFile('rg', args, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024, signal: es })
    return { ran: true, engine: 'ripgrep', hits: toHits(stdout) }
  } catch (e1) {
    const err1 = e1 as { code?: number | string; message?: string }
    if (err1.code === 1) return { ran: true, engine: 'ripgrep', hits: [] }
    // rg 缺失/其他错误 → grep 兜底
    try {
      const args = ['-rni', '--exclude-dir=.git', '-m', '6', ...tokens.flatMap((t) => ['-e', t]), root]
      const { stdout } = await pExecFile('grep', args, { timeout: 15_000, maxBuffer: 2 * 1024 * 1024, signal: es })
      return { ran: true, engine: 'grep', hits: toHits(stdout) }
    } catch (e2) {
      const err2 = e2 as { code?: number | string; message?: string }
      if (err2.code === 1) return { ran: true, engine: 'grep', hits: [] }
      return { ran: false, reason: String(err2.message || err1.message).slice(0, 160), hits: [] }
    }
  }
}

export function cypherEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
