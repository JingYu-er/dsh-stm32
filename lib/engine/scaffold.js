/**
 * L2：从零建工程骨架。
 *
 * 为什么需要它：CubeMX 的脚本模式**只产 Core/ 下的 C 源**（实测 E1–E4，见规格书 §8.3），
 * 不产 CMakeLists.txt / cmake\** / startup / .ld / Drivers / .vscode。
 * 所以"空目录 → 一条命令出工程"必须由插件补脚手架，而脚手架只能**复刻、不发明**（规格 §7 C1/C6）：
 *
 * - CMake 工程文件、链接脚本、.vscode、.ioc 模板：随插件下发的**模板快照**
 *   （来源 = 同版本 CubeMX GUI 真实生成的工程，逐字节原样，只替换工程名）；
 * - Drivers/**、startup_*.s、system_stm32f1xx.c：从本机 CubeMX 固件包
 *   `<cubeRoot>/Repository/STM32Cube_FW_F1_<ver>` **原样复制**（实测与 GUI 工程逐字节一致）。
 *
 * 产物里没有 .mxproject：那是 GUI 独有的工程元数据，插件不伪造（伪造成本高低不平、还容易和 .ioc 不一致）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_FIRMWARE_PACKAGE = "STM32Cube_FW_F1_V1.8.7";
export const DEFAULT_MCU_CUBE_VERSION = "6.15.0";
export const SCAFFOLD_PROJECT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** 模板目录随插件走：lib/engine/scaffold.js → ../../templates/scaffold。 */
export function templateDir() {
    return fileURLToPath(new URL("../../templates/scaffold/", import.meta.url));
}
function listFiles(root) {
    const out = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory())
                walk(full);
            else
                out.push(full);
        }
    };
    walk(root);
    return out;
}
/**
 * 固件包里**不拷**的东西（相对 Drivers/）。实测固件包 Drivers 有 5392 个文件、31 s 拷完，
 * 其中 4493 个是 CMSIS 文档站（docs/）、DSP/NN 示例与自测套件、BSP 板级组件——
 * 这些对"给 F1 CMake 工程编译 HAL"没有任何作用，只让工程变大、scaffold 变慢。
 */
const DRIVER_SKIP_PREFIXES = [
    "CMSIS/docs/",
    "CMSIS/DSP/Examples/",
    "CMSIS/DSP/DSP_Lib_TestSuite/",
    "CMSIS/DSP/Projects/",
    "CMSIS/NN/Examples/",
    "CMSIS/NN/NN_Lib_Tests/",
    "BSP/",
];
function copyTree(from, to) {
    let count = 0;
    const walk = (src, dest, relDir) => {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            const rel = relDir === "" ? entry.name : relDir + "/" + entry.name;
            const s = path.join(src, entry.name);
            const d = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                if (DRIVER_SKIP_PREFIXES.some((prefix) => (rel + "/").startsWith(prefix)))
                    continue;
                walk(s, d, rel);
            }
            else {
                fs.copyFileSync(s, d);
                count += 1;
            }
        }
    };
    walk(from, to, "");
    return count;
}
/** 在几个 CubeMX 根目录里找固件包；返回能直接用的那一个。 */
export function resolveFirmwareRoot(cubeMxRoots, packageName = DEFAULT_FIRMWARE_PACKAGE) {
    const checked = [];
    for (const cubeRoot of cubeMxRoots) {
        const candidate = path.join(cubeRoot, "Repository", packageName);
        checked.push(candidate);
        const drivers = path.join(candidate, "Drivers", "STM32F1xx_HAL_Driver");
        const cmsis = path.join(candidate, "Drivers", "CMSIS", "Include");
        const templates = path.join(candidate, "Drivers", "CMSIS", "Device", "ST", "STM32F1xx", "Source", "Templates");
        if (fs.existsSync(drivers) && fs.existsSync(cmsis) && fs.existsSync(path.join(templates, "gcc", "startup_stm32f103xb.s"))) {
            return { root: candidate, checked };
        }
    }
    return { checked };
}
/**
 * 建工程骨架（不调用 CubeMX；生成 Core/ 由 stm32_generate 负责）。
 */
export function createProjectScaffold(request) {
    const startedAt = Date.now();
    const targetDir = path.resolve(request.targetDir);
    const projectName = request.projectName ?? path.basename(targetDir);
    const firmwarePackage = request.firmwarePackage ?? DEFAULT_FIRMWARE_PACKAGE;
    const failures = [];
    const fail = (message, warnings = []) => ({
        ok: false,
        targetDir,
        projectName,
        iocPath: path.join(targetDir, projectName + ".ioc"),
        templateDir: templateDir(),
        templateFiles: 0,
        driverFiles: 0,
        durationMs: Date.now() - startedAt,
        warnings,
        message,
    });
    if (!SCAFFOLD_PROJECT_NAME.test(projectName)) {
        return fail("工程名必须是 C 标识符（字母/下划线开头，只含字母数字下划线）：" + projectName);
    }
    if (fs.existsSync(targetDir) && !request.overwrite) {
        const entries = fs.readdirSync(targetDir);
        if (entries.length > 0) {
            return fail("目标目录不是空的（" + String(entries.length) + " 项）：" + targetDir + "。换一个目录，或显式 overwrite=true（会覆盖同名文件）。");
        }
    }
    const tpl = templateDir();
    if (!fs.existsSync(tpl))
        return fail("插件模板目录缺失：" + tpl + "（重新安装插件）");
    const firmware = resolveFirmwareRoot(request.cubeMxRoots ?? [], firmwarePackage);
    if (firmware.root === undefined) {
        return fail("找不到 CubeMX 固件包 " + firmwarePackage + "（找过：" + firmware.checked.join("；") + "）。" +
            "固件包是 Drivers/ 与 startup 的唯一合法来源，插件不内嵌 ST 代码。");
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(path.join(targetDir, "Core", "Src"), { recursive: true });
    fs.mkdirSync(path.join(targetDir, "Core", "Inc"), { recursive: true });
    // 1) 模板快照：CMake 工程文件 / 链接脚本 / .vscode / .ioc（只替换工程名）
    let templateFiles = 0;
    for (const source of listFiles(tpl)) {
        const rel = path.relative(tpl, source).replace(/\\/gu, "/");
        let text = fs.readFileSync(source, "utf8");
        if (rel !== ".gitignore" && rel !== "STM32F103XX_FLASH.ld") {
            text = text.split("__PROJECT_NAME__").join(projectName);
        }
        const destRel = rel.startsWith("vscode/")
            ? path.join(".vscode", rel.slice("vscode/".length))
            : rel === "demo.ioc"
                ? projectName + ".ioc"
                : rel;
        const dest = path.join(targetDir, destRel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
        templateFiles += 1;
    }
    // 2) 固件包：Drivers 全量 + startup + system（与 GUI 新工程逐字节一致）
    const driverFiles = copyTree(path.join(firmware.root, "Drivers"), path.join(targetDir, "Drivers"));
    const templatesDir = path.join(firmware.root, "Drivers", "CMSIS", "Device", "ST", "STM32F1xx", "Source", "Templates");
    fs.copyFileSync(path.join(templatesDir, "gcc", "startup_stm32f103xb.s"), path.join(targetDir, "startup_stm32f103xb.s"));
    fs.copyFileSync(path.join(templatesDir, "system_stm32f1xx.c"), path.join(targetDir, "Core", "Src", "system_stm32f1xx.c"));
    const iocPath = path.join(targetDir, projectName + ".ioc");
    const warnings = [
        "没有生成 .mxproject：那是 CubeMX GUI 的工程元数据，插件不伪造；用 GUI 打开并生成一次即可补上。",
        "Core/ 下的 main.c 等还没生成：接着调 stm32_generate（3–4 分钟，需要 CubeMX 全权限）。",
    ];
    if (failures.length > 0)
        warnings.push(...failures);
    return {
        ok: true,
        targetDir,
        projectName,
        iocPath,
        firmwareRoot: firmware.root,
        templateDir: tpl,
        templateFiles,
        driverFiles,
        durationMs: Date.now() - startedAt,
        warnings,
        message: "工程骨架已建好（" + String(templateFiles) + " 个工程文件 + " + String(driverFiles) + " 个固件文件）：" + targetDir,
    };
}
