/**
 * L3：stm32_ioc_apply —— 改 .ioc 的第二步：校验暂存副本 → 备份 → 原子替换（规格 I3、§11 A8）。
 *
 * 两道闸：① 源文件 SHA-256 必须与 plan 时一致；② 候选文件 SHA-256 必须与 plan 时一致。
 * 任一不符直接拒绝（宁可让人重新 plan，也不把没确认过的内容写进去）。
 * rollbackFrom 走回滚路径，把某次备份的 .ioc 写回去（写前再备份当前文件）。
 *
 * 不需要设备事实（只搬 .ioc 字节），所以不 ensureAssets。
 */
import { applyIocPlan, rollbackIoc } from "../engine/ioc-plan.js";
import { resolveProjectDir } from "./project-dir.js";
export const IOC_APPLY_TOOL = "stm32_ioc_apply";
export const outputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        message: { type: "string" },
        mode: { type: "string", enum: ["apply", "rollback"] },
        ok: { type: "boolean" },
        projectDir: { type: "string" },
        iocPath: { type: "string" },
        planId: { type: "string" },
        appliedChanges: { type: "number" },
        /**
         * 这一趟是不是回滚。为什么要单独一个字段：回滚不改配置，却和"应用了变更"共用一张报告，
         * 只靠 mode 判断的话调用方很容易把回滚读成"改了 1 处"（审计 A18）。
         */
        rolledBack: { type: "boolean" },
        shaBefore: { type: "string" },
        shaAfter: { type: "string" },
        backupPath: { type: "string" },
        warnings: { type: "array", items: { type: "string" } },
        notes: { type: "array", items: { type: "string" } },
    },
    required: [
        "message", "mode", "ok", "projectDir", "iocPath", "planId", "appliedChanges",
        "rolledBack", "shaBefore", "shaAfter", "backupPath", "warnings", "notes",
    ],
};
export function registerIocApply(ctx) {
    ctx.tools.register({
        name: IOC_APPLY_TOOL,
        description: "改 .ioc 的第二步：把 stm32_ioc_plan 生成的计划真正写入（核对源文件与候选文件 SHA-256 → 备份到 .dsh-stm32/backups/ → 原子替换）。传 rollbackFrom 则是回滚：把某次备份的 .ioc 写回去。写完后用 stm32_generate 让 CubeMX 按新配置重写非 USER CODE 区。",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                projectDir: { type: "string", description: "工程根目录；缺省为当前工作目录。" },
                planId: { type: "string", description: "stm32_ioc_plan 返回的 planId（apply 必填）。" },
                rollbackFrom: { type: "string", description: "回滚：.dsh-stm32/backups/ 下某次备份的 .ioc 路径（绝对或相对工程目录）。" },
            },
        },
        timeoutMs: 30_000,
        isConcurrencySafe: () => false,
        output: {
            schema: outputSchema,
            render: (_args, value) => {
                const typed = value;
                const lines = [typed.message];
                if (typed.shaBefore !== "" && typed.shaAfter !== "") {
                    lines.push("SHA-256：" + typed.shaBefore.slice(0, 16) + "… -> " + typed.shaAfter.slice(0, 16) + "…");
                }
                if (typed.rolledBack)
                    lines.push("这是回滚：appliedChanges 记 0（回滚不是应用变更）。");
                if (typed.backupPath !== "")
                    lines.push("备份：" + typed.backupPath);
                for (const note of typed.notes)
                    lines.push("· " + note);
                for (const warning of typed.warnings)
                    lines.push("! " + warning);
                return [{ type: "text", text: lines.join("\n") }];
            },
        },
        async execute(rawArgs, exec) {
            // 宿主可能不传 arguments（工具无参数调用）→ rawArgs 是 undefined。
            // 这里兜成 {} 而不是相信它一定有值：缺参数的正常表现应该是"报告说缺 planId"，不是 TypeError（审计 A31）。
            const args = rawArgs ?? {};
            const resolution = await resolveProjectDir(ctx, args.projectDir, exec);
            const projectDir = resolution.projectDir;
            const extraNotes = resolution.note === null ? [] : [resolution.note];
            if (args.rollbackFrom !== undefined && args.rollbackFrom !== "") {
                const rollback = rollbackIoc({ projectDir, backupFrom: args.rollbackFrom });
                return {
                    message: rollback.message,
                    mode: "rollback",
                    ok: rollback.ok,
                    projectDir: rollback.projectDir,
                    iocPath: rollback.iocPath,
                    planId: "",
                    // 回滚没有"应用变更"这回事：原来记 rollback.ok ? 1 : 0 是拿数字编事实（审计 A18）。
                    appliedChanges: 0,
                    rolledBack: rollback.ok,
                    shaBefore: rollback.shaBefore,
                    shaAfter: rollback.shaAfter,
                    backupPath: rollback.backupPath,
                    warnings: [],
                    notes: [...(rollback.ok ? ["回滚后建议 stm32_generate 重新生成，让代码与 .ioc 一致"] : []), ...extraNotes],
                };
            }
            const planId = args.planId ?? "";
            if (planId === "") {
                return {
                    message: "没写入：必须带 planId（先 stm32_ioc_plan 拿到计划 ID）；要回滚请用 rollbackFrom。",
                    mode: "apply", ok: false, projectDir, iocPath: "", planId: "", appliedChanges: 0, rolledBack: false,
                    shaBefore: "", shaAfter: "", backupPath: "", warnings: [], notes: extraNotes,
                };
            }
            const applied = applyIocPlan({ projectDir, planId });
            return {
                message: applied.message,
                mode: "apply",
                ok: applied.ok,
                projectDir: applied.projectDir,
                iocPath: applied.iocPath,
                planId: applied.planId,
                appliedChanges: applied.appliedChanges,
                rolledBack: false,
                shaBefore: applied.shaBefore,
                shaAfter: applied.shaAfter,
                backupPath: applied.backupPath,
                warnings: applied.warnings,
                notes: [...applied.notes, ...extraNotes],
            };
        },
    });
}
