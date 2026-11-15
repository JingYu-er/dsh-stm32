/**
 * 工程结构与配置文件归位（S128）。
 *
 * 默认只规划（dryRun），加 `apply=true` 才动文件；每份被改写的文件先备份成 `.bak`。
 */
import { applyLayoutFix, planLayoutFix } from "../engine/project-repair.js";
import { resolveProjectDir } from "./project-dir.js";
export const LAYOUT_FIX_TOOL = "stm32_layout_fix";
const actionSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        kind: { type: "string", enum: ["index-move", "index-clean", "project-conf-move", "none"] },
        from: { type: "string" },
        to: { type: "string" },
        note: { type: "string" },
    },
    required: ["kind", "from", "to", "note"],
};
export function registerLayoutTools(ctx) {
    ctx.tools.register({
        name: LAYOUT_FIX_TOOL,
        description: "检查并把工程结构与配置文件归位：工作区索引应在 <工作区>/.dsh-stm32/workspace.conf，" +
            "工程描述应在工程根的 dsh-stm32.conf（ioc/build 相对工程根）。默认只报计划，apply=true 才改文件，" +
            "改动前备份成 .bak。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工作区或工程目录；缺省为会话工作目录。" },
                apply: { type: "boolean", description: "true 才真正改文件；默认只规划。" },
            },
            required: [],
        },
        output: {
            schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    ok: { type: "boolean" },
                    applied: { type: "boolean" },
                    error: { type: "string" },
                    workspaceRoot: { type: "string" },
                    actions: { type: "array", items: actionSchema },
                    notes: { type: "array", items: { type: "string" } },
                },
                required: ["ok", "applied", "error", "workspaceRoot", "actions", "notes"],
            },
            render: (_args, value) => {
                const result = value;
                const lines = [result.applied ? "已归位：" : "计划（未改文件）：", "工作区：" + result.workspaceRoot];
                if (result.actions.length === 0)
                    lines.push("结构已符合约定，无需调整。");
                for (const action of result.actions)
                    lines.push("- " + action.kind + "：" + action.note);
                for (const note of result.notes)
                    lines.push("· " + note);
                if (!result.ok)
                    lines.push("有失败项：" + result.error);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        timeoutMs: 60_000,
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
            const project = await resolveProjectDir(ctx, args.projectDir, exec);
            const notes = project.note === null ? [] : [project.note];
            if (project.fallbackToProcessCwd && project.note === null)
                notes.push("没有会话工作目录，按插件进程目录处理");
            if (args.apply === true) {
                const fixed = applyLayoutFix(project.projectDir);
                return {
                    ok: fixed.ok,
                    applied: true,
                    error: fixed.error,
                    workspaceRoot: fixed.workspaceRoot,
                    actions: fixed.actions.map((item) => ({ kind: item.kind, from: item.from, to: item.to, note: item.note })),
                    notes: [...notes, ...fixed.notes],
                };
            }
            const plan = planLayoutFix(project.projectDir);
            return {
                ok: plan.ok,
                applied: false,
                error: plan.error,
                workspaceRoot: plan.workspaceRoot,
                actions: plan.actions.map((item) => ({ kind: item.kind, from: item.from, to: item.to, note: item.note })),
                notes: [...notes, ...plan.notes],
            };
        },
    });
}
