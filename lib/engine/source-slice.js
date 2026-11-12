/**
 * 源码片段：给断点命中、编译错误这类「文件:行」补上上下文。
 *
 * 只读，且只读工程目录内的文件：路径先解析成绝对路径，再要求它落在 projectDir 之下，
 * 防止面板把 `../` 或绝对路径当参数读走别处的文件。
 */
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
/** 一次最多带多少行上下文；面板只显示几行，给太多也没人读。 */
export const SOURCE_CONTEXT_MAX = 20;
/**
 * 把「文件:行」里的文件参数解析成工程内的绝对路径。
 *
 * 接受相对工程的路径（`Core/Src/main.c`）、带反斜杠的 Windows 路径；
 * 绝对路径只有在工程目录内才放行。越界一律 null。
 */
export function resolveSourceFile(projectDir, file) {
    const dir = projectDir.trim();
    const wanted = file.trim();
    if (dir === "" || wanted === "")
        return null;
    const base = resolve(dir);
    const target = resolve(base, wanted);
    if (target === base)
        return null;
    if (!target.startsWith(base + sep))
        return null;
    return target;
}
/** 读文件的一行及其上下文；行号越界时夹到首/尾，不报错。 */
export function readSourceSlice(projectDir, file, line, context = 3) {
    if (typeof line !== "number" || !Number.isFinite(line) || line < 1) {
        return { ok: false, error: "line 必须是 ≥1 的整数" };
    }
    const target = resolveSourceFile(projectDir, file);
    if (target === null)
        return { ok: false, error: "文件必须在工程目录内：" + file };
    let text = "";
    try {
        text = readFileSync(target, "utf8");
    }
    catch (error) {
        return { ok: false, error: "读取源码失败：" + (error instanceof Error ? error.message : String(error)) };
    }
    const all = text.split(/\r?\n/u);
    // 末尾换行会切出一个空元素，去掉它，行号才和编辑器一致。
    if (all.length > 1 && all[all.length - 1] === "")
        all.pop();
    const total = all.length;
    const span = Math.max(0, Math.min(SOURCE_CONTEXT_MAX, Math.floor(context)));
    const focus = Math.min(Math.max(1, Math.floor(line)), Math.max(1, total));
    const from = Math.max(1, focus - span);
    const to = Math.min(total, focus + span);
    const lines = [];
    for (let index = from; index <= to; index += 1) {
        lines.push({ line: index, text: all[index - 1] ?? "" });
    }
    return { ok: true, slice: { file, line: focus, from, to, totalLines: total, lines } };
}
