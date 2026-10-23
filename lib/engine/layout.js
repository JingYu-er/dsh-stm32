/**
 * L1：生成产物落位。
 *
 * CubeMX CLI 只认目录、永远写 <dir>/Src 与 <dir>/Inc（M0 E1/E2 实测；.ioc 里的
 * ProjectManager.MainLocation 被忽略），而 ST 的 CMake 工程把源码放在 Core/Src、
 * 头文件放在 Core/Inc。这里只做纯映射，不碰磁盘。
 */
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
/** CubeMX 生成时使用的相对子目录。 */
export const GEN_SRC_DIR = "Src";
export const GEN_INC_DIR = "Inc";
/** 工程的落位目录（与 CubeMX GUI 的 CMake 生成一致）。 */
export const PROJECT_SRC_DIR = "Core/Src";
export const PROJECT_INC_DIR = "Core/Inc";
/**
 * 把 CubeMX 产物相对路径映射到工程内相对路径。
 * 返回 null 表示这个文件不属于工程结构（例如意外的顶层产物）。
 */
export function mapGeneratedPath(relPath) {
    const normalized = relPath.replace(/\\/g, "/");
    if (normalized.startsWith(GEN_SRC_DIR + "/")) {
        return PROJECT_SRC_DIR + normalized.slice(GEN_SRC_DIR.length);
    }
    if (normalized.startsWith(GEN_INC_DIR + "/")) {
        return PROJECT_INC_DIR + normalized.slice(GEN_INC_DIR.length);
    }
    return null;
}
/** 递归列出某个生成目录下的相对路径（posix 分隔），按字典序。 */
export function listGeneratedFiles(genRoot, subDir) {
    const dir = join(genRoot, subDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
        return [];
    const out = [];
    const walk = (current, prefix) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
            const full = join(current, entry.name);
            if (entry.isDirectory())
                walk(full, rel);
            else if (entry.isFile())
                out.push(subDir + "/" + rel);
        }
    };
    walk(dir, "");
    return out.sort();
}
