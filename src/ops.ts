/**
 * dsh-code-graph 操作实现。
 * op → 引擎工具映射；查询族操作先过保鲜门控；callers/callees/impact 用 CALLS 边
 * Cypher（单跳已实测）；impact = 逐层 BFS（规避方言级变长路径语法风险）。
 * 分支层（2026-09-17）：统一走 resolveProjectBranchAware（multi 每分支一库 /
 * single 大仓滚动单索引），响应带 branch/branchMode/fresh 元数据。
 */
import { runEngine, ensureFresh, resolveProjectBranchAware, ripgrepFallback, cypherEscape, branchInventory, canonPath } from './engine.js'
import type { EngineOptions, BranchResolution, FreshInfo } from './engine.js'

export interface OpArgs {
  op: string
  repo_path?: string
  project?: string
  /** 查询目标分支（缺省=当前检出分支；仅已建索引的分支可查） */
  branch?: string
  query?: string
  name?: string
  mode?: string
  direction?: string
  depth?: number
  max_rows?: number
  path?: string
  since?: string
  fresh?: boolean
}

export interface OpDeps {
  opts: EngineOptions
  signal?: AbortSignal
}

const Q_TIMEOUT = 60_000

function engineOptsWith(deps: OpDeps, freshOverride?: boolean): EngineOptions {
  return freshOverride === undefined ? deps.opts : { ...deps.opts, fresh: freshOverride }
}

type Ready = BranchResolution & { fresh?: FreshInfo }

/** 项目解析（分支感知）+ 查询前保鲜（仅当前检出分支；显式非当前分支为冻结索引不保鲜）。 */
async function readyProject(deps: OpDeps, a: OpArgs, withFresh: boolean): Promise<Ready> {
  const r: Ready = await resolveProjectBranchAware(deps.opts, a)
  if (withFresh && r.isCurrent) {
    r.fresh = await ensureFresh(engineOptsWith(deps, a.fresh), r.project, Q_TIMEOUT)
  }
  return r
}

/** 分支层元数据：注入每个 op 的响应（未触发字段不出现，保持响应面干净）。 */
function resMeta(r: Ready): Record<string, unknown> {
  const m: Record<string, unknown> = {}
  if (r.branch !== undefined) m.branch = r.branch
  if (r.mode !== 'off') m.branchMode = r.mode
  if (r.adopted) m.adopted = true
  if (r.built) m.built = true
  if (r.switched) m.switched = true
  if (r.evicted?.length) m.evicted = r.evicted
  if (r.note) m.note = r.note
  if (r.fresh) m.fresh = r.fresh
  return m
}

/** query_graph 行格式为位置数组（columns+rows），zip 成对象数组。 */
function rowsToObjects(data: any): any[] {
  const cols: any[] = data?.columns ?? []
  const rows: any[] = data?.rows ?? []
  if (!Array.isArray(rows)) return []
  if (rows.some((r) => !Array.isArray(r))) return rows
  return rows.map((r: any[]) => {
    const o: Record<string, unknown> = {}
    cols.forEach((c: any, i: number) => { o[String(c)] = r[i] })
    return o
  })
}

export async function dispatchOp(a: OpArgs, deps: OpDeps): Promise<Record<string, unknown>> {
  const { opts, signal } = deps
  switch (a.op) {
    case 'projects': {
      const r = await runEngine(opts, 'list_projects', {}, 30_000, signal)
      return { op: a.op, projects: r.data?.projects ?? [] }
    }
    case 'status': {
      const r = await resolveProjectBranchAware(opts, a)
      const st = await runEngine(opts, 'index_status', { project: r.project }, 30_000, signal)
      const out: Record<string, unknown> = { op: a.op, project: r.project, status: st.data, ...resMeta(r) }
      if (r.mode !== 'off' && r.rootPath) {
        const inv = await branchInventory(opts, canonPath(r.rootPath))
        if (inv) out.branches = inv
      }
      return out
    }
    case 'index': {
      if (!a.repo_path) throw new Error('[dsh-code-graph] op=index 需要 repo_path（canonical 绝对路径）')
      const mode = a.mode ?? opts.defaultMode
      const t0 = Date.now()
      // 分支感知：alias 命中 → 增量；legacy 签名全等 → 采纳不重建；否则删旧建新（single）/建 @分支（multi）
      const r = await resolveProjectBranchAware({ ...opts, defaultMode: mode }, a, { forIndex: true })
      const st = await runEngine(opts, 'index_status', { project: r.project }, 30_000, signal)
      return {
        op: a.op,
        project: r.project,
        indexMode: mode,
        ms: Date.now() - t0,
        nodes: r.raw?.nodes ?? st.data?.nodes,
        edges: r.raw?.edges ?? st.data?.edges,
        status: st.data?.status ?? 'unknown',
        raw: r.raw ?? undefined,
        ...resMeta(r),
      }
    }
    case 'changes': {
      const r = await readyProject(deps, a, false)
      const args: Record<string, unknown> = { project: r.project }
      if (a.since) args.since = a.since
      const c = await runEngine(opts, 'detect_changes', args, Q_TIMEOUT, signal)
      return { op: a.op, changes: c.data, project: r.project, ...resMeta(r) }
    }
    case 'query': {
      if (!a.query) throw new Error('[dsh-code-graph] op=query 需要 query（关键词/符号名；BM25 结构加权排序）')
      const r = await readyProject(deps, a, true)
      const rows = a.max_rows ?? opts.maxRows
      const s = await runEngine(opts, 'search_graph', { project: r.project, query: a.query, 'max_rows': rows }, Q_TIMEOUT, signal)
      const results: any[] = s.data?.results ?? []
      const out: Record<string, unknown> = {
        op: a.op,
        project: r.project,
        total: s.data?.total ?? results.length,
        results: results.slice(0, rows),
        ...resMeta(r),
      }
      if (results.length === 0 && r.rootPath) {
        const fb = await ripgrepFallback(r.rootPath, a.query, signal)
        out.fallback = { engine: 'ripgrep', ran: fb.ran, reason: fb.reason, hits: fb.hits }
      }
      return out
    }
    case 'callers':
    case 'callees': {
      if (!a.name) throw new Error('[dsh-code-graph] op=' + a.op + ' 需要 name（函数/方法名）')
      const r = await readyProject(deps, a, true)
      const n = cypherEscape(a.name)
      const cy = a.op === 'callers'
        ? "MATCH (up)-[c:CALLS]->(f) WHERE f.name = '" + n + "' RETURN up.name AS name, up.qualified_name AS qualified_name, up.file_path AS file, c.line AS line"
        : "MATCH (f)-[c:CALLS]->(down) WHERE f.name = '" + n + "' RETURN down.name AS name, down.qualified_name AS qualified_name, down.file_path AS file, c.line AS line"
      const q = await runEngine(opts, 'query_graph', { project: r.project, query: cy, 'max_rows': a.max_rows ?? opts.maxRows }, Q_TIMEOUT, signal)
      const objs = rowsToObjects(q.data)
      return { op: a.op, project: r.project, name: a.name, total: q.data?.total ?? objs.length, rows: objs, hint: q.data?.hint, ...resMeta(r) }
    }
    case 'impact': {
      if (!a.name) throw new Error('[dsh-code-graph] op=impact 需要 name（从该符号向上做调用方 BFS）')
      const r = await readyProject(deps, a, true)
      const depth = Math.min(Math.max(a.depth ?? 3, 1), 8)
      const limit = a.max_rows ?? opts.maxRows
      const frontier = new Set<string>([a.name])
      const seen = new Set<string>([a.name])
      const layers: { depth: number; callers: any[] }[] = []
      for (let d = 1; d <= depth && frontier.size > 0; d++) {
        const rows: any[] = []
        for (const node of [...frontier]) {
          const n = cypherEscape(node)
          const cy = "MATCH (up)-[c:CALLS]->(f) WHERE f.name = '" + n + "' RETURN DISTINCT up.name AS name, up.qualified_name AS qualified_name, up.file_path AS file"
          const q = await runEngine(opts, 'query_graph', { project: r.project, query: cy, 'max_rows': 200 }, Q_TIMEOUT, signal)
          for (const row of rowsToObjects(q.data)) {
            if (row?.name && !seen.has(String(row.name))) { seen.add(String(row.name)); rows.push(row) }
          }
        }
        layers.push({ depth: d, callers: rows.slice(0, limit) })
        frontier.clear()
        for (const row of rows) frontier.add(String(row.name))
      }
      return { op: a.op, project: r.project, name: a.name, depth, affected: layers, total: seen.size - 1, ...resMeta(r) }
    }
    case 'trace': {
      if (!a.name) throw new Error('[dsh-code-graph] op=trace 需要 name')
      const r = await readyProject(deps, a, true)
      const args: Record<string, unknown> = { 'function_name': a.name, project: r.project }
      if (a.mode) args.mode = a.mode
      if (a.direction) args.direction = a.direction
      if (a.depth) args.depth = a.depth
      if (a.max_rows) args['max_rows'] = a.max_rows
      const t = await runEngine(opts, 'trace_path', args, Q_TIMEOUT, signal)
      return { op: a.op, project: r.project, trace: t.data, ...resMeta(r) }
    }
    case 'architecture': {
      const r = await readyProject(deps, a, false)
      const args: Record<string, unknown> = { project: r.project, aspects: ['overview'] }
      if (a.path) args.path = a.path
      const g = await runEngine(opts, 'get_architecture', args, Q_TIMEOUT, signal)
      return { op: a.op, project: r.project, architecture: g.data, ...resMeta(r) }
    }
    case 'snippet': {
      if (!a.name) throw new Error('[dsh-code-graph] op=snippet 需要 name（qualified_name 或短函数名，来自 query 结果）')
      const r = await readyProject(deps, a, false)
      const s = await runEngine(opts, 'get_code_snippet', { 'qualified_name': a.name, project: r.project, 'include_neighbors': false }, Q_TIMEOUT, signal)
      return { op: a.op, project: r.project, snippet: s.data, ...resMeta(r) }
    }
    default:
      throw new Error('[dsh-code-graph] 未知 op: ' + a.op + '（合法: projects/status/index/changes/query/callers/callees/impact/trace/architecture/snippet）')
  }
}
