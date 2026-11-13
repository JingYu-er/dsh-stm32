/**
 * dsh-stm32 —— 插件入口（宿主侧，无 UI）。
 *
 * 结构：L0 engine/subprocess-runner（进程）→ L1 engine/*（纯逻辑）→
 *      L3 tools/*（模型可见工具）← 本文件只做装配。
 *
 * 依赖注入：inject 声明的服务在 apply 时已就绪；tools 注册工具，
 * subprocess 提供 Job 范围的进程终止能力。
 *
 * 唯一的状态清理入口在此：`turn/end` 到达（本轮输出结束、等待回复）时关闭长调试会话，
 * 此后可随时在 VS Code 里按 F5，探针不会被插件长期占用（规格 §6.4）。
 */
import { registerCommands } from "./commands/register.js";
import { debugSessions } from "./engine/debug-session.js";
import { stopRtt } from "./engine/rtt.js";
import { cleanupSerialOnTurnEnd, closeSerial } from "./engine/serial.js";
import { registerStm32Skill } from "./skill/stm32-workflow.js";
import { registerAssets } from "./tools/assets.js";
import { registerBuild } from "./tools/build.js";
import { registerCache } from "./tools/cache.js";
import { registerCodePatch } from "./tools/code-patch.js";
import { registerDebugRun } from "./tools/debug.js";
import { registerDebugSession } from "./tools/debug-session.js";
import { registerDoctor } from "./tools/doctor.js";
import { registerDownload } from "./tools/download.js";
import { registerEnvInstall } from "./tools/env-install.js";
import { registerFirmwareInstall } from "./tools/firmware-install.js";
import { registerFlash } from "./tools/flash.js";
import { registerGenerate } from "./tools/generate.js";
import { registerIocApply } from "./tools/ioc-apply.js";
import { registerIocInspect } from "./tools/ioc-inspect.js";
import { registerIocPlan } from "./tools/ioc-plan.js";
import { registerIocVerify } from "./tools/ioc-verify.js";
import { registerProjectCreate } from "./tools/project-create.js";
import { registerProjectExport } from "./tools/project-export.js";
import { registerRegsRead } from "./tools/regs.js";
import { registerRoutePlan } from "./tools/route-plan.js";
import { registerRtt } from "./tools/rtt.js";
import { registerSerial } from "./tools/serial.js";
import { registerWatchTool } from "./tools/watch.js";
import { registerWebRoutes } from "./engine/web-routes.js";
import { setSessionWorkspaceResolver } from "./engine/web-api.js";
import { emitEvent } from "./engine/event-bus.js";
import { startEventLog } from "./engine/event-log.js";
import { instrumentContext } from "./engine/tool-events.js";
import { stopChannelTaps } from "./engine/channel-tap.js";
import { watchRecorder } from "./engine/watch-record.js";
export const name = "dsh-stm32";
export const inject = ["tools", "subprocess", "jobs"];
/**
 * A9：从 turn/end 事件里尽量挖出发起方的 agent id。
 *
 * 宿主没公开事件结构，所以这里按可能的位置逐个试；全都取不到就返回空串
 * （debug-session 见到空串会退回原来的「无条件关会话」行为，不会漏关）。
 */
export function callerIdOf(event, session) {
    const sources = [event, session];
    for (const source of sources) {
        if (source === null || typeof source !== "object")
            continue;
        const record = source;
        const nested = [record["agent"], record["session"]];
        for (const candidate of [record["agentId"], record["owner"], ...nested]) {
            if (candidate === null || typeof candidate !== "object") {
                if (typeof candidate === "string" && candidate !== "")
                    return candidate;
                continue;
            }
            const id = candidate["id"];
            if (typeof id === "string" && id !== "")
                return id;
        }
    }
    return "";
}
export function apply(ctx) {
    // 工具注册走一层代理：每次调用记 start / ok / fail，调试台的事件流由此而来。
    const toolsCtx = instrumentContext(ctx);
    // 被环形缓冲挤出的事件按批落进证据目录（每会话一个目录）。
    const stopEventLog = startEventLog();
    const stopLog = () => {
        emitEvent({
            source: "system",
            kind: "lifecycle",
            status: "info",
            summary: "插件卸载，事件日志停止",
        });
        void stopEventLog();
    };
    registerEnvInstall(toolsCtx);
    registerDownload(toolsCtx);
    registerFirmwareInstall(toolsCtx);
    registerProjectCreate(toolsCtx);
    registerProjectExport(toolsCtx);
    registerCodePatch(toolsCtx);
    registerGenerate(toolsCtx);
    registerIocInspect(toolsCtx);
    registerIocPlan(toolsCtx);
    registerIocApply(toolsCtx);
    registerIocVerify(toolsCtx);
    registerBuild(toolsCtx);
    registerFlash(toolsCtx);
    registerDebugRun(toolsCtx);
    registerDebugSession(toolsCtx);
    registerRegsRead(toolsCtx);
    registerRoutePlan(toolsCtx);
    registerRtt(toolsCtx);
    registerWatchTool(toolsCtx);
    registerAssets(toolsCtx);
    registerCache(toolsCtx);
    registerDoctor(toolsCtx);
    registerSerial(toolsCtx);
    // 设置面板的宿主 API（浏览器端 lib/client.js 用）。宿主没 webServer 服务时静默跳过。
    registerWebRoutes(toolsCtx);
    // 面板没传 projectDir 时按会话工作目录兜底（S84）：宿主没这个服务就留空，接口回 400 说明原因。
    if (typeof ctx.get === "function") {
        setSessionWorkspaceResolver(async () => {
            const service = ctx.get("workingDirectory");
            if (service === undefined || typeof service.ensure !== "function")
                return "";
            try {
                return await service.ensure(undefined);
            }
            catch {
                return "";
            }
        });
    }
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
        ctx.on("session/event", (session, event) => {
            if (event?.type !== "turn/end")
                return;
            // RTT 的 rtt server 依附同一个 openocd：会话关闭后该通道随之终止，本地状态不能继续
            // 报 running。先收 RTT 再收会话，顺序只影响日志好不好看。
            void stopRtt();
            // A9：只关这条会话自己开的调试会话。事件结构宿主没公开，所以按可能的位置逐个试；
            // 全都取不到就传空串，debug-session 会退回原来的「无条件关」行为。
            const owner = callerIdOf(event, session);
            void debugSessions.stop("turn/end：本轮输出结束，交还探针", owner === "" ? {} : { requireOwner: owner });
            // 串口默认不跨 turn：turn 结束就把口放掉，别让一个 COM 口被忘在后台。
            // persist=true 的会话由 cleanupSerialOnTurnEnd 自己判断并保留（顺带扫死会话目录）。
            // 这里 catch 掉异常：收尾失败不该让宿主事件处理器抛错。
            void cleanupSerialOnTurnEnd({}).catch(() => undefined);
        });
        ctx.on("session/disposed", () => {
            stopChannelTaps();
            watchRecorder.reset();
            void debugSessions.stop("session/disposed");
            // 会话已不存在，persist=true 的串口同样不保留（该串口没有下一个 turn 可复用）。
            void closeSerial({}).catch(() => undefined);
        });
        ctx.on("dispose", () => {
            stopChannelTaps();
            watchRecorder.reset();
            stopLog();
            void debugSessions.stop("插件卸载");
            void closeSerial({}).catch(() => undefined);
        });
    }
}
