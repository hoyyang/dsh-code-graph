export interface EngineOptions {
    bin: string;
    defaultMode: string;
    fresh: boolean;
    freshThrottleSec: number;
    maxRows: number;
    /** 分支索引层总开关：false = 整体回退单索引跟随行为（legacy 路径派生名） */
    branchIndex: boolean;
    /** multi 模式每仓库分支项目上限（LRU，含当前分支；legacy path-slug 项目不计入） */
    maxBranchProjects: number;
    /** 项目 DB 超过该字节数 → single（大仓滚动单索引）模式 */
    branchIndexMaxDbBytes: number;
    /** 插件侧索引签名持久化文件（head_sha 实时态不可信，需自记快照） */
    stateFile?: string;
}
export declare function resolveBin(bin: string): string;
export interface RunResult {
    ok: boolean;
    data: any;
    stderrTail: string;
}
/** 单次 CLI 调用：stdin 传 JSON args（非弃用通道），stdout 解析 JSON。 */
export declare function runEngine(opts: EngineOptions, tool: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<RunResult>;
export declare function listProjects(opts: EngineOptions, force?: boolean): Promise<any[]>;
export declare function indexSingleFlight(opts: EngineOptions, repoPath: string, mode: string, timeoutMs: number, name?: string): Promise<any>;
/** delete_project 包装：删除成功返回 true；失败 fail-open（由淘汰/清理方决定是否继续）。 */
export declare function deleteProject(opts: EngineOptions, project: string): Promise<boolean>;
export interface AliasEntry {
    project: string;
    at: number;
}
export interface RepoReg {
    /** multi 模式：原始分支名 → 分支项目 */
    alias?: Record<string, AliasEntry>;
    /** single 模式：预期分支槽位（稳态每仓只留这一份分支索引） */
    single?: {
        branch: string;
        project: string;
        at: number;
    };
}
/** 索引成功后记录该项目的签名快照（op=index 与自动重索引共用）。 */
export declare function recordSig(opts: EngineOptions, project: string, root: string, stateFile?: string): Promise<void>;
export interface FreshInfo {
    checked: boolean;
    drift: boolean;
    reindexed: boolean;
    headSha?: string;
    dirty?: boolean;
    note?: string;
}
/** 查询前保鲜：实时态 vs 插件侧索引快照，漂移则 fast 增量重索引（窗口节流防抖）。 */
export declare function ensureFresh(opts: EngineOptions, project: string, timeoutMs: number): Promise<FreshInfo>;
export interface BranchResolution {
    project: string;
    rootPath?: string;
    /** 目标分支（当前检出或显式指定；非 git 目录为 undefined） */
    branch?: string;
    /** 分支层模式：off = branchIndex 关闭/非 git */
    mode: 'multi' | 'single' | 'off';
    /** 目标是否当前检出分支（决定能否做保鲜比对） */
    isCurrent: boolean;
    /** legacy 项目被采纳为当前分支索引（零重建） */
    adopted?: boolean;
    /** 本次解析实际执行了索引（新建或显式 index 的增量） */
    built?: boolean;
    /** single 模式发生了删旧建新切换 */
    switched?: boolean;
    /** 本次被删除的项目（淘汰/单槽清理，fail-open 只记成功者） */
    evicted?: string[];
    note?: string;
    raw?: any;
}
export declare function canonPath(p: string): string;
export declare function branchSlug(b: string): string;
/** 分支项目名：路径 slug + '__' + 分支 slug（引擎把 @ 规范化为 -，__ 原样保留——spike 实测）。 */
export declare function branchProjectName(rootPath: string, branch: string): string;
/** 当前检出分支；detached HEAD → detached-<sha7>；非 git 目录 → null。 */
export declare function currentBranch(root: string): Promise<string | null>;
/** 分支注册表清单（op=status 用）：multi = 分支项目列表；single = 预期分支槽位。 */
export declare function branchInventory(opts: EngineOptions, canon: string): Promise<Record<string, unknown> | undefined>;
/**
 * 分支感知项目解析。
 *
 * - 显式 project / branchIndex 关闭 / 非 git 目录 → 单项目直取（legacy 行为）；
 * - multi：alias 命中 → legacy 签名采纳 → 建 @分支 项目（LRU 淘汰）；
 * - single：预期分支命中 → 删旧建新（用户拍板：每次使用核对分支，不一致删旧建新）；
 * - 显式 branch ≠ 当前检出：只读已建索引（不保鲜——工作树不是该分支），无则 fail-loud。
 */
export declare function resolveProjectBranchAware(opts: EngineOptions, a: {
    repo_path?: string;
    project?: string;
    branch?: string;
}, o?: {
    forIndex?: boolean;
}): Promise<BranchResolution>;
export declare function ripgrepFallback(root: string, query: string, signal?: AbortSignal): Promise<{
    ran: boolean;
    engine?: string;
    reason?: string;
    hits: string[];
}>;
export declare function cypherEscape(s: string): string;
