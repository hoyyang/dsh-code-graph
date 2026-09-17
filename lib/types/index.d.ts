import z from '@deepseek-ai/schemastery';
export declare const name = "dsh-code-graph";
export declare const inject: string[];
/** 宿主服务面（本地窄类型；effect 收 unknown/清理函数，dsh-concise 实测约定）。 */
interface HostCtx {
    tools: {
        register(tool: unknown): unknown;
        get?(name: string, scope?: unknown): unknown;
    };
    commands?: {
        register(cmd: unknown): unknown;
    };
    systemPrompt?: {
        section(s: unknown): unknown;
    };
    effect(fn: () => unknown | (() => void), label?: string): unknown;
    logger?: {
        warn?(msg: string): void;
        info?(msg: string): void;
    };
}
export interface Config {
    bin: string;
    defaultMode: string;
    fresh: boolean;
    freshThrottleSec: number;
    maxRows: number;
    hint: boolean;
    skill: boolean;
    gate: boolean;
    /** 分支索引层：false = 整体回退单索引跟随行为 */
    branchIndex: boolean;
    /** multi 模式每仓库分支项目上限（LRU） */
    maxBranchProjects: number;
    /** 项目 DB 超过该字节数 → single（大仓滚动单索引）模式 */
    branchIndexMaxDbBytes: number;
}
export declare const Config: z<Schemastery.ObjectS<{
    bin: z<string, string>;
    defaultMode: z<string, string>;
    fresh: z<boolean, boolean>;
    freshThrottleSec: z<number, number>;
    maxRows: z<number, number>;
    hint: z<boolean, boolean>;
    skill: z<boolean, boolean>;
    gate: z<boolean, boolean>;
    branchIndex: z<boolean, boolean>;
    maxBranchProjects: z<number, number>;
    branchIndexMaxDbBytes: z<number, number>;
}>, Schemastery.ObjectT<{
    bin: z<string, string>;
    defaultMode: z<string, string>;
    fresh: z<boolean, boolean>;
    freshThrottleSec: z<number, number>;
    maxRows: z<number, number>;
    hint: z<boolean, boolean>;
    skill: z<boolean, boolean>;
    gate: z<boolean, boolean>;
    branchIndex: z<boolean, boolean>;
    maxBranchProjects: z<number, number>;
    branchIndexMaxDbBytes: z<number, number>;
}>>;
export declare function apply(ctx: HostCtx, config: Config): void;
export {};
