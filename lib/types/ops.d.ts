import type { EngineOptions } from './engine.js';
export interface OpArgs {
    op: string;
    repo_path?: string;
    project?: string;
    /** 查询目标分支（缺省=当前检出分支；仅已建索引的分支可查） */
    branch?: string;
    query?: string;
    name?: string;
    mode?: string;
    direction?: string;
    depth?: number;
    max_rows?: number;
    path?: string;
    since?: string;
    fresh?: boolean;
}
export interface OpDeps {
    opts: EngineOptions;
    signal?: AbortSignal;
}
export declare function dispatchOp(a: OpArgs, deps: OpDeps): Promise<Record<string, unknown>>;
