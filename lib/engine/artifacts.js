/**
 * 产物与内存：读构建目录里的 elf / hex / bin，配上芯片的 Flash / RAM 容量，供调试台显示。
 *
 * 只读文件属性，不跑 size / objdump：内存占用来自上一次 `stm32_build` 的
 * `--print-memory-usage` 结果（面板从事件流里取），避免为了一个数字再起一个子进程。
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { findChipFact } from "../data/device-facts.js";
import { detectBuildDir, findElf } from "./build.js";
import { readIocCpn } from "./breakpoints.js";
function statFile(file) {
    try {
        const info = statSync(file);
        return { name: basename(file), path: file, size: info.size, mtimeMs: info.mtimeMs };
    }
    catch {
        return null;
    }
}
/** 与 elf 同名、扩展名不同的兄弟产物。 */
function sibling(elfPath, extension) {
    const dot = elfPath.lastIndexOf(".");
    const base = dot === -1 ? elfPath : elfPath.slice(0, dot);
    return statFile(base + extension);
}
function listElves(buildDir) {
    let names;
    try {
        names = readdirSync(buildDir);
    }
    catch {
        return [];
    }
    const files = [];
    for (const name of names) {
        if (!name.toLowerCase().endsWith(".elf"))
            continue;
        const file = statFile(join(buildDir, name));
        if (file !== null)
            files.push(file);
    }
    return files;
}
export function readArtifacts(projectDir, env = process.env) {
    const dir = projectDir.trim();
    if (dir === "")
        return { ok: false, error: "projectDir 不能为空" };
    const notes = [];
    const buildDir = detectBuildDir(dir) ?? "";
    if (buildDir === "") {
        notes.push("还没有可识别的构建目录：先执行 stm32_build 或 cmake --preset。");
    }
    let elfInfo = null;
    if (buildDir !== "")
        elfInfo = findElf(buildDir);
    const elf = elfInfo === null ? null : statFile(elfInfo.path);
    const hex = elf === null ? null : sibling(elf.path, ".hex");
    const bin = elf === null ? null : sibling(elf.path, ".bin");
    const otherElves = buildDir === "" ? [] : listElves(buildDir).filter((file) => file.path !== elf?.path);
    if (otherElves.length > 0) {
        notes.push("构建目录里有 " + String(otherElves.length + 1) + " 个 .elf，当前显示按工程名/修改时间挑出的那个。");
    }
    const cpn = readIocCpn(dir);
    let chip = null;
    if (cpn !== "") {
        const fact = findChipFact(cpn, env);
        if (fact === null)
            notes.push("资源包里没有 " + cpn + " 的容量数据，内存占用只能看构建输出。");
        else
            chip = { cpn, flashBytes: fact.flashBytes, ramBytes: fact.ramBytes };
    }
    else {
        notes.push("工程里没有 .ioc 的 Mcu.CPN，无法给出容量上限。");
    }
    return {
        ok: true,
        report: {
            projectDir: dir,
            buildDir,
            elf,
            hex,
            bin,
            otherElves,
            chip,
            notes,
        },
    };
}
/** 构建目录存在但还没有产物的判断，供面板给出下一步。 */
export function hasBuildDir(projectDir) {
    const dir = detectBuildDir(projectDir);
    return dir !== null && existsSync(dir);
}
