/**
 * dsh-stm32 —— 插件入口（宿主侧，无 UI）。
 *
 * 结构：L0 engine/subprocess-runner（进程）→ L1 engine/*（纯逻辑）→
 *      L3 tools/*（模型可见工具）← 本文件只做装配。
 *
 * 依赖注入：inject 声明的服务在 apply 时已就绪；tools 注册工具，
 * subprocess 提供 Job 范围的进程终止能力。
 *
 * 唯一的状态清理入口在这里：`turn/end` 到达（我输出完、等你回复）就关掉长调试会话，
 * 这样你随时能在 VS Code 里按 F5 —— 探针不会被插件攥着（规格 §6.4）。
 */
import { registerCommands } from "./commands/register.js";
import { debugSessions } from "./engine/debug-session.js";
import { registerStm32Skill } from "./skill/stm32-workflow.js";
import { registerBuild } from "./tools/build.js";
import { registerCache } from "./tools/cache.js";
import { registerCodePatch } from "./tools/code-patch.js";
import { registerDebugRun } from "./tools/debug.js";
import { registerDebugSession } from "./tools/debug-session.js";
import { registerDoctor } from "./tools/doctor.js";
import { registerEnvInstall } from "./tools/env-install.js";
import { registerEnvProbe } from "./tools/env-probe.js";
import { registerFirmwareInstall } from "./tools/firmware-install.js";
import { registerFlash } from "./tools/flash.js";
import { registerGenerate } from "./tools/generate.js";
import { registerIocApply } from "./tools/ioc-apply.js";
import { registerIocInspect } from "./tools/ioc-inspect.js";
import { registerIocPlan } from "./tools/ioc-plan.js";
import { registerProjectCreate } from "./tools/project-create.js";
import { registerRegsRead } from "./tools/regs.js";
import { registerRoutePlan } from "./tools/route-plan.js";
export const name = "dsh-stm32";
export const inject = ["tools", "subprocess", "jobs"];
export function apply(ctx) {
    registerEnvProbe(ctx);
    registerEnvInstall(ctx);
    registerFirmwareInstall(ctx);
    registerProjectCreate(ctx);
    registerCodePatch(ctx);
    registerGenerate(ctx);
    registerIocInspect(ctx);
    registerIocPlan(ctx);
    registerIocApply(ctx);
    registerBuild(ctx);
    registerFlash(ctx);
    registerDebugRun(ctx);
    registerDebugSession(ctx);
    registerRegsRead(ctx);
    registerRoutePlan(ctx);
    registerCache(ctx);
    registerDoctor(ctx);
    // 斜杠命令与 SKILL 是"锦上添花"的层：宿主没组合 commands / skills 服务时静默跳过，
    // 工具本身照常可用（用 ctx.inject 而不是顶层 inject，避免整个插件因缺服务不加载）。
    if (typeof ctx.inject === "function") {
        ctx.inject(["commands", "subprocess", "workingDirectory"], (scope) => {
            registerCommands(scope);
        });
        ctx.inject(["skills"], (scope) => {
            registerStm32Skill(scope);
        });
    }
    else {
        registerCommands(ctx);
        registerStm32Skill(ctx);
    }
    if (typeof ctx.on === "function") {
        ctx.on("session/event", (_session, event) => {
            if (event?.type !== "turn/end")
                return;
            void debugSessions.stop("turn/end：本轮输出结束，把探针还给你");
        });
        ctx.on("session/disposed", () => {
            void debugSessions.stop("session/disposed");
        });
        ctx.on("dispose", () => {
            void debugSessions.stop("插件卸载");
        });
    }
}
