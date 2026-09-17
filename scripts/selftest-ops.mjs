// dsh-code-graph 操作直测（不经 LLM）：一次性 git 仓库端到端
// 套件 A = legacy 行为（branchIndex 关闭，回归保障）；套件 B/C/D = 分支索引层（multi/single/采纳）
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { dispatchOp } from '../lib/ops.js'
import { branchProjectName, canonPath } from '../lib/engine.js'

const CLI = join(homedir(), '.local/bin/codebase-memory-mcp')
const base = { bin: '~/.local/bin/codebase-memory-mcp', defaultMode: 'fast', fresh: true, freshThrottleSec: 0, maxRows: 20 }
const stateDir = mkdtempSync(join(tmpdir(), 'dsh-cg-test-st-')) // state 文件必须在仓库外（否则成为未跟踪文件污染 dirty 位）
const optsA = { ...base } // legacy：branchIndex 缺省关闭
const optsB = { ...base, branchIndex: true, maxBranchProjects: 6, branchIndexMaxDbBytes: 524288000, stateFile: join(stateDir, 'b.json') }
const optsB1 = { ...optsB, maxBranchProjects: 1 }
const optsC = { ...optsB, branchIndexMaxDbBytes: 0 } // 强制 single（大仓滚动单索引）

const root = mkdtempSync(join(tmpdir(), 'dsh-cg-test-'))
const rootB = mkdtempSync(join(tmpdir(), 'dsh-cg-test-b-'))
const rootC = mkdtempSync(join(tmpdir(), 'dsh-cg-test-c-'))
const results = []
let failed = 0
function check(name, cond, detail) {
  results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : ''))
  if (!cond) failed++
}
const created = new Set()
async function op(args, opts2) {
  const r = await dispatchOp(args, { opts: opts2 })
  if (r && typeof r.project === 'string') created.add(r.project)
  return r
}
function mkRepo(root2) {
  mkdirSync(root2, { recursive: true })
  execSync('git init -q && git -C . config user.email t@t && git -C . config user.name t', { cwd: root2 })
  writeFileSync(join(root2, 'util.ts'), 'export function helperFn(x: number): number { return x * 2 }\n')
  writeFileSync(join(root2, 'main.ts'), "import { helperFn } from './util.js'\nexport function callerFn(): number { return helperFn(21) }\n")
  execSync('git add -A && git commit -qm init', { cwd: root2 })
}
function commitAll(root2, msg) {
  execSync('git add -A && git commit -qm ' + msg, { cwd: root2 })
}
const branchOf = (root2) => execSync('git rev-parse --abbrev-ref HEAD', { cwd: root2 }).toString().trim()

try {
  // ── 套件 A：legacy 行为（branchIndex 关闭）──
  mkRepo(root)
  const idx = await op({ op: 'index', repo_path: root }, optsA)
  check('index', idx.status === 'ready' && idx.nodes > 0, 'project=' + idx.project + ' nodes=' + idx.nodes + ' edges=' + idx.edges + ' ms=' + idx.ms)
  const proj = idx.project
  check('legacy-naming', !proj.includes('@') && !proj.includes('__'), 'project=' + proj)

  const st = await op({ op: 'status', project: proj }, optsA)
  check('status', st.status?.status === 'ready', 'status=' + st.status?.status)

  const q = await op({ op: 'query', project: proj, query: 'helperFn' }, optsA)
  check('query', (q.results ?? []).length > 0, 'total=' + q.total)

  const callers = await op({ op: 'callers', project: proj, name: 'helperFn' }, optsA)
  const callerNames = (callers.rows ?? []).map((r) => r.name)
  check('callers', callerNames.includes('callerFn'), JSON.stringify(callerNames))

  const callees = await op({ op: 'callees', project: proj, name: 'callerFn' }, optsA)
  const calleeNames = (callees.rows ?? []).map((r) => r.name)
  check('callees', calleeNames.includes('helperFn'), JSON.stringify(calleeNames))

  // 保鲜门控：新提交后 head_sha 漂移 → 查询前自动重索引
  appendFileSync(join(root, 'main.ts'), 'export function callerFn2(): number { return helperFn(42) }\n')
  commitAll(root, 'more')
  const callers2 = await op({ op: 'callers', project: proj, name: 'helperFn' }, optsA)
  const names2 = (callers2.rows ?? []).map((r) => r.name)
  check('freshness+callers2', names2.includes('callerFn2'), JSON.stringify(names2))

  const impact = await op({ op: 'impact', project: proj, name: 'helperFn', depth: 3 }, optsA)
  const affected = (impact.affected ?? []).flatMap((l) => l.callers.map((c) => c.name))
  check('impact', affected.includes('callerFn') && affected.includes('callerFn2'), JSON.stringify(affected) + ' total=' + impact.total)

  const snip = await op({ op: 'snippet', project: proj, name: 'helperFn' }, optsA)
  const snipText = JSON.stringify(snip.snippet)
  check('snippet', snipText.includes('helperFn'), snipText.slice(0, 120))

  const arch = await op({ op: 'architecture', project: proj }, optsA)
  check('architecture', JSON.stringify(arch.architecture).length > 10, 'ok')

  const chg = await op({ op: 'changes', project: proj }, optsA)
  check('changes', chg.changes !== undefined, JSON.stringify(chg.changes).slice(0, 120))

  const fb = await op({ op: 'query', project: proj, query: 'zzz_nonexistent_symbol_qq' }, optsA)
  check('rg fallback', fb.fallback?.ran === true, 'ran=' + fb.fallback?.ran + ' hits=' + (fb.fallback?.hits ?? []).length)

  // loud failure：未索引仓库必须点名报错
  try {
    await op({ op: 'status', repo_path: '/tmp/definitely-not-indexed-xyz' }, optsA)
    check('fail-loud', false, 'should have thrown')
  } catch (e) {
    check('fail-loud', String(e.message).includes('未索引') || String(e.message).includes('无法定位'), String(e.message).slice(0, 120))
  }

  // ── 套件 B：multi 模式（每分支一库 + LRU）──
  mkRepo(rootB)
  const mainB = branchOf(rootB)
  const canonB = canonPath(rootB)
  const expMain = branchProjectName(canonB, mainB)
  const expFeat = branchProjectName(canonB, 'feat')

  const idxB = await op({ op: 'index', repo_path: rootB }, optsB)
  check('b-index@branch', idxB.project === expMain && idxB.branchMode === 'multi' && idxB.branch === mainB && idxB.built === true, 'project=' + idxB.project)

  const qB = await op({ op: 'query', repo_path: rootB, query: 'helperFn' }, optsB)
  check('b-query-follows-branch', qB.project === expMain && (qB.results ?? []).length > 0 && qB.fresh?.reindexed === false, 'project=' + qB.project + ' fresh=' + JSON.stringify(qB.fresh))

  execSync('git checkout -qb feat', { cwd: rootB })
  writeFileSync(join(rootB, 'feat.ts'), 'export function featOnly(): number { return 1 }\n')
  commitAll(rootB, 'feat')
  const qB2 = await op({ op: 'query', repo_path: rootB, query: 'featOnly' }, optsB)
  check('b-auto-build-on-new-branch', qB2.project === expFeat && qB2.built === true && (qB2.results ?? []).length > 0, 'project=' + qB2.project + ' built=' + qB2.built)

  execSync('git checkout -q ' + mainB, { cwd: rootB })
  const qB3 = await op({ op: 'query', repo_path: rootB, query: 'helperFn' }, optsB)
  check('b-switch-back-zero-reindex', qB3.project === expMain && qB3.fresh?.reindexed !== true, 'project=' + qB3.project + ' fresh=' + JSON.stringify(qB3.fresh))

  const qB4 = await op({ op: 'query', repo_path: rootB, branch: 'feat', query: 'featOnly' }, optsB)
  check('b-branch-param-frozen', qB4.project === expFeat && qB4.fresh === undefined && (qB4.results ?? []).length > 0, 'project=' + qB4.project + ' fresh=' + (qB4.fresh === undefined ? 'absent' : 'present'))

  try {
    await op({ op: 'query', repo_path: rootB, branch: 'ghost', query: 'x' }, optsB)
    check('b-branch-missing-fail-loud', false, 'should have thrown')
  } catch (e) {
    check('b-branch-missing-fail-loud', String(e.message).includes('尚无索引图'), String(e.message).slice(0, 140))
  }

  execSync('git checkout -q --detach HEAD', { cwd: rootB })
  const qB5 = await op({ op: 'query', repo_path: rootB, query: 'helperFn' }, optsB)
  check('b-detached-naming', typeof qB5.project === 'string' && qB5.project.startsWith(expMain.split('__')[0] + '__detached-'), 'project=' + qB5.project)
  execSync('git checkout -q ' + mainB, { cwd: rootB })

  // LRU 淘汰：max=1 下建 feat2 → 其余分支项目被删
  execSync('git checkout -qb feat2', { cwd: rootB })
  writeFileSync(join(rootB, 'feat2.ts'), 'export function featTwo(): number { return 2 }\n')
  commitAll(rootB, 'feat2')
  const qB6 = await op({ op: 'query', repo_path: rootB, query: 'featTwo' }, optsB1)
  check('b-eviction-lru', qB6.project === branchProjectName(canonB, 'feat2') && Array.isArray(qB6.evicted) && qB6.evicted.includes(expMain), 'evicted=' + JSON.stringify(qB6.evicted))
  const pjB = await dispatchOp({ op: 'projects' }, { opts: optsB })
  const slugB = canonB.replace(/^\//, '').replace(/\//g, '-')
  const branchProjB = (pjB.projects ?? []).map((p) => p.name).filter((n) => String(n).startsWith(slugB + '__'))
  check('b-eviction-cap', branchProjB.length <= 1, 'branchProjects=' + JSON.stringify(branchProjB))
  // 淘汰后切回 main：重建恢复
  execSync('git checkout -q ' + mainB, { cwd: rootB })
  const qB7 = await op({ op: 'query', repo_path: rootB, query: 'helperFn' }, optsB)
  check('b-eviction-recovery-rebuild', qB7.project === expMain && qB7.built === true, 'project=' + qB7.project + ' built=' + qB7.built)

  // ── 套件 C：single 模式（大仓滚动单索引，阈值调 0 模拟）──
  mkRepo(rootC)
  const mainC = branchOf(rootC)
  const canonC = canonPath(rootC)
  const expCMain = branchProjectName(canonC, mainC)
  const idxC = await op({ op: 'index', repo_path: rootC }, optsC)
  check('c-index-single', idxC.project === expCMain && idxC.branchMode === 'single', 'project=' + idxC.project + ' mode=' + idxC.branchMode)

  execSync('git checkout -qb featc', { cwd: rootC })
  writeFileSync(join(rootC, 'featc.ts'), 'export function featCOnly(): number { return 3 }\n')
  commitAll(rootC, 'featc')
  const qC = await op({ op: 'query', repo_path: rootC, query: 'featCOnly' }, optsC)
  check('c-switch-delete-rebuild', qC.project === branchProjectName(canonC, 'featc') && qC.switched === true && Array.isArray(qC.evicted) && qC.evicted.includes(expCMain), 'project=' + qC.project + ' evicted=' + JSON.stringify(qC.evicted))
  const pjC = await dispatchOp({ op: 'projects' }, { opts: optsC })
  const stillThere = (pjC.projects ?? []).some((p) => p.name === expCMain)
  check('c-single-slot-steady', !stillThere, 'old=' + expCMain + ' stillPresent=' + stillThere)
  const stC = await op({ op: 'status', repo_path: rootC }, optsC)
  check('c-status-expected-branch', stC.branches?.mode === 'single' && stC.branches?.expectedBranch === 'featc', JSON.stringify(stC.branches).slice(0, 160))
  try {
    await op({ op: 'query', repo_path: rootC, branch: mainC, query: 'x' }, optsC)
    check('c-single-branch-param-guard', false, 'should have thrown')
  } catch (e) {
    check('c-single-branch-param-guard', String(e.message).includes('单槽'), String(e.message).slice(0, 140))
  }

  // ── 套件 D：legacy 采纳（升级零迁移）──
  // 套件 A 已用 legacy 行为索引 rootA（projA 为路径派生名）；分支层查询应直接采纳，不重建
  const optsD = { ...optsB, stateFile: join(stateDir, 'd.json') }
  const qD = await op({ op: 'query', repo_path: root, query: 'helperFn' }, optsD)
  check('d-legacy-adoption', qD.project === proj && qD.adopted === true && qD.branchMode === 'multi' && qD.fresh?.reindexed !== true, 'project=' + qD.project + ' adopted=' + qD.adopted + ' fresh=' + JSON.stringify(qD.fresh))
} finally {
  // 清理测试产生的引擎库（只删本测试命名空间的项目）+ 临时仓库
  for (const name of created) {
    try { execSync('"' + CLI + '" cli delete_project --project "' + name + '"', { stdio: 'ignore' }) } catch {}
  }
  for (const r of [root, rootB, rootC, stateDir]) {
    try { rmSync(r, { recursive: true, force: true }) } catch {}
  }
}
console.log(results.join('\n'))
console.log(failed === 0 ? 'ALL PASS (' + results.length + ')' : failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
