/**
 * 工具入口的两个共用动作：定"工程目录"、校验必填参数。
 *
 * 洞 A（真缺陷）：以前每个工具都写 args.projectDir ?? process.cwd()，而插件宿主进程的 cwd 是
 * profile 目录（例如 C:\\Users\\<用户>\\.dsh\\profiles\\desktop），于是省略 projectDir 时会去检查
 * 一个根本不存在的"工程"，还可能照样报 ok。这里改成先问宿主的 workingDirectory 服务（会话工作
 * 目录 = 用户在 IDE 里打开的工程），只有宿主没这个服务或调用失败时才退回 process.cwd()，并且把
 * "退回了"写进报告 notes，让用户知道该显式传 projectDir。
 *
 * 洞 C：参数名写错（例如把 file/block/code 写成 edits）时，报告的必需字段会是 undefined，宿主
 * 序列化时直接抛 "returned invalid output: value is not lossless JSON"，真正原因被淹没。入口先
 * 校验，缺参数就回一句中文说明，报告字段一律填默认值。
 */
function usableDir(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}
/**
 * 决定这次工具该操作哪个工程目录。
 *
 * 顺序：显式 projectDir → 宿主 workingDirectory 服务（会话工作目录）→ 插件进程 cwd（并警告）。
 */
export async function resolveProjectDir(ctx, explicit, exec) {
    const given = usableDir(explicit);
    if (given !== null)
        return { projectDir: given, note: null, fallbackToProcessCwd: false };
    let failure = null;
    const service = typeof ctx.get === "function" ? ctx.get("workingDirectory") : undefined;
    if (service !== undefined && typeof service.ensure === "function") {
        try {
            const sessionDir = usableDir(await service.ensure(exec?.agent, exec?.signal));
            if (sessionDir !== null) {
                return {
                    projectDir: sessionDir,
                    note: "工程目录缺省取会话工作目录：" + sessionDir,
                    fallbackToProcessCwd: false,
                };
            }
            failure = "会话工作目录是空的";
        }
        catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }
    }
    else {
        failure = "宿主没有 workingDirectory 服务";
    }
    const fallback = process.cwd();
    return {
        projectDir: fallback,
        note: "拿不到会话工作目录（" + (failure ?? "未知原因") + "），缺省用了插件进程的 cwd（" + fallback +
            "）；如果这不是你的工程，请显式传 projectDir",
        fallbackToProcessCwd: true,
    };
}
function isBlank(value) {
    return typeof value === "string" && value.trim() === "";
}
/**
 * 校验必填参数。返回 null 表示通过，否则返回一句可以直接给用户看的中文说明。
 *
 * 只做"形状"校验（缺没缺、是不是字符串/字符串数组），值本身合不合法交给引擎层。
 */
export function validateToolArgs(toolName, args, required) {
    const missing = [];
    const wrongKind = [];
    for (const spec of required) {
        const value = args[spec.name];
        if (value === undefined || value === null || isBlank(value)) {
            missing.push(spec.name);
            continue;
        }
        if (spec.kind === "string") {
            if (typeof value !== "string")
                wrongKind.push(spec.name);
            continue;
        }
        if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
            wrongKind.push(spec.name);
        }
    }
    if (missing.length === 0 && wrongKind.length === 0)
        return null;
    const parts = [];
    if (missing.length > 0)
        parts.push("缺少 " + missing.join("、"));
    if (wrongKind.length > 0)
        parts.push(wrongKind.map((name) => name + " 的类型不对").join("、"));
    const expected = required
        .map((spec) => spec.name + (spec.kind === "string[]" ? "（字符串数组）" : "（字符串）"))
        .join("、");
    return toolName + " 参数不正确：" + parts.join("；") + "。必填参数：" + expected + "。";
}
