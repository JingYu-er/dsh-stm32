/**
 * 工程结构与配置文件归位（S128）。
 *
 * 同名 `dsh-stm32.conf` 存两种内容：工作区索引（`project=`）与工程描述（`name=`/`mcu=`/`ioc=`…）。
 * 放在同一个文件里必然出现「这一行属于谁」的歧义，工程描述还常被写进 `fw/` 这类子目录。
 * 规范位置：
 *
 * - 工作区索引：`<工作区>/.dsh-stm32/workspace.conf`
 * - 工程描述：  `<工程根>/dsh-stm32.conf`（`ioc=`/`build=` 一律相对工程根）
 * - 插件状态：  `<工程根>/.dsh-stm32/`
 *
 * 归位动作只有两类：子目录里的工程描述并回工程根；工程根里的索引行搬到上一级的工作区索引。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CONF_FILE_NAME, WORKSPACE_CONF_REL, parseConf, writeProjectConf } from "./project-conf.js";
const SKIP = new Set(["node_modules", "build", "build_pc", "Drivers", "Core", "cmake", ".git", "__pycache__", "docs", "artifacts"]);
/** 工程根 = 含 `.ioc` 的目录；`fw/` 这类子目录不算工程根，它只是程序目录。 */
function projectRootOf(dir) {
    try {
        if (readdirSync(dir).some((name) => name.endsWith(".ioc")))
            return dir;
    }
    catch {
        return dir;
    }
    return dir;
}
/** 程序目录：优先 `fw` 等候选，其次深度 ≤2 扫 `*.ioc`；找不到返回空串。 */
export function firmwareDirOf(root) {
    const candidates = ["program", "firmware", "app", "user", "fw", "code", ""];
    for (const name of candidates) {
        const dir = name === "" ? root : join(root, name);
        try {
            if (readdirSync(dir).some((entry) => entry.endsWith(".ioc")))
                return dir;
        }
        catch {
            /* 目录不存在则继续 */
        }
    }
    let entries = [];
    try {
        entries = readdirSync(root, { withFileTypes: true })
            .filter((item) => item.isDirectory() && !item.name.startsWith(".") && !SKIP.has(item.name))
            .map((item) => item.name);
    }
    catch {
        return "";
    }
    for (const name of entries) {
        const child = join(root, name);
        try {
            if (readdirSync(child).some((entry) => entry.endsWith(".ioc")))
                return child;
        }
        catch {
            /* 忽略不可读目录 */
        }
    }
    return "";
}
function projectKeys(confPath) {
    if (!existsSync(confPath))
        return {};
    const doc = parseConf(readFileSync(confPath, "utf8"), confPath);
    const out = {};
    for (const key of ["name", "mcu", "ioc", "build", "firmware", "hardware"]) {
        const value = doc.single.get(key);
        if (value !== undefined && value !== "")
            out[key] = value;
    }
    return out;
}
function indexPathOf(workspaceRoot) {
    return join(workspaceRoot, WORKSPACE_CONF_REL);
}
/** 规划归位（只读）。 */
export function planLayoutFix(input) {
    const root = resolve(input.trim() === "" ? "." : input);
    const projectDir = projectRootOf(root);
    const actions = [];
    const notes = [];
    const rootConf = join(projectDir, CONF_FILE_NAME);
    // 1) 程序目录里的工程描述并回工程根。
    const fw = firmwareDirOf(projectDir);
    if (fw !== "" && fw !== projectDir && existsSync(join(fw, CONF_FILE_NAME))) {
        const sub = join(fw, CONF_FILE_NAME);
        const merged = { ...projectKeys(sub), ...projectKeys(rootConf) };
        const ioc = merged["ioc"] ?? "";
        const fwRel = relative(projectDir, fw).replace(/\\/gu, "/");
        const iocRel = ioc === "" ? "" : relative(projectDir, resolve(fw, ioc)).replace(/\\/gu, "/");
        actions.push({
            kind: "project-conf-move",
            from: sub,
            to: rootConf,
            note: "工程描述从 " + fwRel + "/ 并回工程根（ioc=" + (iocRel === "" ? "未写" : iocRel) + "，firmware=" + fwRel + "）",
        });
    }
    // 2) 工程根里的索引行搬到上一级的工作区索引。
    if (existsSync(rootConf)) {
        const doc = parseConf(readFileSync(rootConf, "utf8"), rootConf);
        const projects = doc.multi.get("project") ?? [];
        if (projects.length > 0) {
            const workspaceRoot = dirname(projectDir);
            actions.push({
                kind: "index-move",
                from: rootConf,
                to: indexPathOf(workspaceRoot),
                note: "工作区索引从工程根挪到 " + basename(workspaceRoot) + "/.dsh-stm32/workspace.conf（" + String(projects.length) + " 项）",
            });
            for (const entry of projects) {
                const abs = resolve(projectDir, entry);
                if (abs === projectDir)
                    continue;
                notes.push("索引项 " + entry + " 指向 " + abs + "，挪走后仍可用路径引用");
            }
        }
    }
    return { ok: true, error: "", workspaceRoot: dirname(projectDir), actions, notes };
}
/** 执行归位；被改写的文件先备份成 `<文件>.bak`。 */
export function applyLayoutFix(input) {
    const plan = planLayoutFix(input);
    if (!plan.ok)
        return plan;
    const root = resolve(input.trim() === "" ? "." : input);
    const projectDir = projectRootOf(root);
    const rootConf = join(projectDir, CONF_FILE_NAME);
    const failed = [];
    for (const action of plan.actions) {
        try {
            if (action.kind === "project-conf-move") {
                const text = readFileSync(action.from, "utf8");
                const sub = parseConf(text, action.from);
                const merged = { ...projectKeys(action.from), ...projectKeys(rootConf) };
                const fw = dirname(action.from);
                const fwRel = relative(projectDir, fw).replace(/\\/gu, "/");
                const iocRaw = merged["ioc"] ?? "";
                const iocRel = iocRaw === "" ? "" : relative(projectDir, resolve(fw, iocRaw)).replace(/\\/gu, "/");
                writeFileSync(action.from + ".bak", text, "utf8");
                writeProjectConf(projectDir, {
                    name: merged["name"] ?? sub.single.get("name"),
                    mcu: merged["mcu"],
                    ioc: iocRel,
                    build: merged["build"],
                    firmware: merged["firmware"] ?? fwRel,
                    hardware: merged["hardware"],
                });
                unlinkSync(action.from);
            }
            else if (action.kind === "index-move") {
                const text = readFileSync(action.from, "utf8");
                const doc = parseConf(text, action.from);
                const entries = doc.multi.get("project") ?? [];
                const workspaceRoot = dirname(projectDir);
                const target = action.to;
                const header = "# dsh-stm32 工作区索引：由插件写入，手工增删也可。\n# 一行一个工程，写相对路径或目录名。\nversion=1\n";
                const existing = existsSync(target) ? readFileSync(target, "utf8").replace(/\s*$/u, "\n") : header;
                const projectRel = relative(workspaceRoot, projectDir).replace(/\\/gu, "/");
                // 工程根里的 project= 指向的是它的子目录（如 fw），那些不是独立工程，挪走后丢弃。
                const wanted = new Set();
                for (const entry of entries) {
                    const abs = resolve(projectDir, entry);
                    if (abs === projectDir || abs.startsWith(projectDir + sep))
                        continue;
                    wanted.add(relative(workspaceRoot, abs).replace(/\\/gu, "/"));
                }
                wanted.add(projectRel);
                let body = existing;
                for (const rel of wanted) {
                    if (!body.includes("project=" + rel + "\n"))
                        body += "project=" + rel + "\n";
                }
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, body, "utf8");
                writeFileSync(action.from + ".bak", text, "utf8");
                const keep = text
                    .split(/\r?\n/u)
                    .filter((line) => !line.trim().startsWith("project="))
                    .join("\n")
                    .trim();
                if (keep === "" || keep === "version=1")
                    unlinkSync(action.from);
                else
                    writeFileSync(action.from, keep + "\n", "utf8");
            }
        }
        catch (error) {
            failed.push(action.note + "：" + (error instanceof Error ? error.message : String(error)));
        }
    }
    const after = planLayoutFix(input);
    return {
        ok: failed.length === 0 && after.actions.length === 0,
        error: failed.join("；"),
        workspaceRoot: plan.workspaceRoot,
        actions: plan.actions,
        notes: [...plan.notes, ...(after.actions.length === 0 ? ["归位后结构符合约定"] : ["仍有未归位项，请查看 actions"])],
    };
}
/** 是否需要归位（doctor / 面板提示用）。 */
export function layoutNeedsFix(input) {
    return planLayoutFix(input).actions.length > 0;
}
