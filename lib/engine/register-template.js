/**
 * 寄存器版工程：从缓存拉 CMSIS 模板，再拼出一个不用 CubeMX / 不用 HAL 的 CMake 工程。
 *
 * 为什么模板不预置进插件（用户 2026-10-24 决定）：插件要覆盖任意 STM32，每颗芯片的
 * startup + 设备头 + 内核头都打一份进 npm 包，包会大到不可用。所以：
 *   第一次用 → 从网上下载（多候选源，见 fetch.ts）→ 落到可检索缓存目录（见 cache.ts）
 *   以后用   → 直接复用缓存，不联网
 *
 * 工程里的 Drivers/CMSIS 与 HAL 工程布局一致（ST 固件包的摆放），所以同一套 include 约定、
 * 同一个工具链文件、同一个链接脚本都能直接复用；差别只是源文件里不出现 HAL 调用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CMSIS_FAMILIES, cmsisTemplatePlan, startupChoiceFor } from "../data/cmsis-sources.js";
import { cacheRootInfo, checkCacheEntry, findCacheEntry, readCacheIndex, upsertCacheEntry } from "./cache.js";
import { fetchAll } from "./fetch.js";
import { SCAFFOLD_PROJECT_NAME, templateDir } from "./scaffold.js";
/** 寄存器版模板目录：lib/engine/register-template.js → ../../templates/register。 */
export function registerTemplateDir() {
    return fileURLToPath(new URL("../../templates/register/", import.meta.url));
}
/** 型号/族 → 启动文件与设备宏；认不出返回 null（不猜文件名）。 */
export function resolveStartupChoice(request) {
    const mcu = (request.mcu ?? "").trim();
    if (mcu !== "")
        return startupChoiceFor(mcu);
    const family = (request.family ?? "F1").trim().toUpperCase();
    // 只给族时按中容量档（F1 → xB）：蓝丸 C8T6 正是这一档，也是最常见的入门芯片。
    return startupChoiceFor(family + ":B");
}
function emptyResult(cacheRoot, error, message) {
    return { ok: false, family: "", id: "", cacheRoot, entryDir: "", cacheHit: false, startup: "", deviceDefine: "", deviceHeader: "", files: 0, bytes: 0, error, message };
}
/**
 * 确保某颗芯片的 CMSIS 模板在缓存里。
 *
 * 顺序：查索引 → 校验文件（缺/大小不对就重下）→ 下载（并发 3、每个文件多候选源）→
 * 写 THIRD_PARTY_NOTICES.md → 写索引。任何一步失败都返回 ok:false + 人话原因，
 * 不抛异常（工具层要把原因贴到卡片上）。
 */
export async function ensureCmsisTemplate(request = {}) {
    const env = request.env ?? process.env;
    const info = cacheRootInfo(env);
    const choice = resolveStartupChoice(request);
    if (choice === null) {
        return emptyResult(info.root, "unsupported-mcu", "认不出这颗芯片的启动文件（目前只做 STM32F1 的 F103 系列）：" + ((request.mcu ?? request.family ?? "") || "(没给型号)") + "。换 F103 型号，或改用 HAL 路线（.ioc + CubeMX）。");
    }
    const plan = cmsisTemplatePlan(choice);
    if (plan === null)
        return emptyResult(info.root, "unsupported-family", "这一代还没有下载清单：" + choice.family + "。");
    const { index, error: indexError } = readCacheIndex(env);
    if (indexError !== null)
        request.onProgress?.(indexError);
    const existing = findCacheEntry(index, "cmsis", plan.id);
    if (existing !== null) {
        const health = checkCacheEntry(existing);
        if (health.ok) {
            return {
                ok: true,
                family: plan.family,
                id: plan.id,
                cacheRoot: info.root,
                entryDir: existing.root,
                cacheHit: true,
                startup: choice.startup,
                deviceDefine: choice.define,
                deviceHeader: choice.deviceHeader,
                files: existing.files.length,
                bytes: existing.totalBytes,
                error: "",
                message: "缓存里已有 " + plan.id + "（" + String(existing.files.length) + " 个文件），没有联网。",
            };
        }
        const broken = health.missing.length + health.changed.length;
        request.onProgress?.("缓存条目 " + plan.id + " 有 " + String(broken) + " 个文件缺失或大小不对，重新下载。");
    }
    if (request.download === false) {
        return {
            ...emptyResult(info.root, "not-cached", "寄存器模板不在缓存里（" + plan.id + "）：这台机器还没下载过，而这次调用被要求不联网。去掉 download=false 再试一次。"),
            family: plan.family,
            id: plan.id,
            startup: choice.startup,
            deviceDefine: choice.define,
            deviceHeader: choice.deviceHeader,
        };
    }
    const entryDir = path.join(info.root, plan.dirName);
    fs.mkdirSync(entryDir, { recursive: true });
    request.onProgress?.("下载 " + String(plan.targets.length) + " 个模板文件到 " + entryDir + "（第一次用需要联网，以后复用缓存）。");
    const options = {
        onProgress: (outcome, done, total) => {
            request.onProgress?.("下载 " + String(done) + "/" + String(total) + "：" + outcome.path + (outcome.ok ? " ✓" : " ✗ " + outcome.error));
        },
    };
    if (request.fetchImpl !== undefined)
        options.fetchImpl = request.fetchImpl;
    if (request.signal !== undefined)
        options.signal = request.signal;
    const fetched = await fetchAll(plan.targets, entryDir, options);
    if (fetched.failed > 0) {
        const failures = fetched.results.filter((item) => !item.ok).slice(0, 3).map((item) => item.path + "：" + item.error);
        const failedResults = fetched.results.filter((item) => !item.ok);
        const allNotFound = failedResults.length > 0 && failedResults.every((item) => item.attempts.length > 0 && item.attempts.every((line) => line.includes("HTTP 404")));
        // 半截缓存比没有缓存更糟：下一次会把不完整的目录当成模板用。
        fs.rmSync(entryDir, { recursive: true, force: true });
        return {
            ...emptyResult(info.root, "download-failed", "模板没下下来（" + String(fetched.failed) + "/" + String(plan.targets.length) + " 个文件失败），已清掉半截目录。第一条失败原因：" + (failures[0] ?? "(未知)") + "。"
                + (allNotFound ? "这几个文件在上游就是 404：多半是这一代/这一档的模板清单写错了（插件 bug），换型号没用，先走 HAL 路线或报告这个问题。" : "多半是网络/代理问题：换网络重试，或手动把 ST 固件包（STM32Cube_FW_F1_*）装到 CubeMX 的 Repository 里走 HAL 路线。")),
            family: plan.family,
            id: plan.id,
            startup: choice.startup,
            deviceDefine: choice.define,
            deviceHeader: choice.deviceHeader,
        };
    }
    const files = fetched.results.map((outcome) => ({ path: outcome.path, bytes: outcome.bytes, url: outcome.url }));
    const upstream = new Set();
    for (const target of plan.targets)
        for (const url of target.urls)
            upstream.add(url);
    fs.writeFileSync(path.join(entryDir, "THIRD_PARTY_NOTICES.md"), plan.license, "utf8");
    const entry = {
        id: plan.id,
        kind: "cmsis",
        family: plan.family,
        label: plan.family + " / " + choice.startup.replace(/\.s$/u, "") + "（CMSIS 设备头 + 启动文件 + 内核头）",
        root: entryDir,
        createdAt: new Date().toISOString(),
        totalBytes: fetched.bytes,
        files,
        sources: Array.from(upstream).sort(),
        license: plan.license,
    };
    upsertCacheEntry(entry, env);
    request.onProgress?.("缓存已更新：" + plan.id);
    return {
        ok: true,
        family: plan.family,
        id: plan.id,
        cacheRoot: info.root,
        entryDir,
        cacheHit: false,
        startup: choice.startup,
        deviceDefine: choice.define,
        deviceHeader: choice.deviceHeader,
        files: files.length,
        bytes: fetched.bytes,
        error: "",
        message: "已下载 " + String(files.length) + " 个模板文件到缓存（" + entryDir + "），下次直接用。",
    };
}
/** 从 HAL 骨架模板里借来的**与 HAL 无关**的文件（工具链、presets、链接脚本、.gitignore）。 */
const SHARED_TEMPLATE_FILES = ["CMakePresets.json", ".gitignore", "STM32F103XX_FLASH.ld", "cmake/gcc-arm-none-eabi.cmake"];
function countFiles(root) {
    let count = 0;
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory())
                walk(path.join(dir, entry.name));
            else
                count += 1;
        }
    };
    if (fs.existsSync(root))
        walk(root);
    return count;
}
/**
 * 建一个寄存器版工程：模板（CMakeLists + main.c）来自插件，CMSIS/启动文件来自缓存，
 * 工具链与链接脚本复用 HAL 骨架里那几份**不含 HAL 内容**的文件。
 */
export async function createRegisterProject(request) {
    const startedAt = Date.now();
    const targetDir = path.resolve(request.targetDir);
    const projectName = request.projectName ?? path.basename(targetDir);
    const mcu = (request.mcu ?? "STM32F103C8T6").trim();
    const fail = (message, warnings = []) => ({
        ok: false,
        targetDir,
        projectName,
        route: "register",
        mcu,
        family: "",
        startup: "",
        deviceDefine: "",
        cacheRoot: cacheRootInfo(request.env ?? process.env).root,
        cacheHit: false,
        templateFiles: 0,
        driverFiles: 0,
        durationMs: Date.now() - startedAt,
        warnings,
        message,
    });
    if (!SCAFFOLD_PROJECT_NAME.test(projectName)) {
        return fail("工程名必须是 C 标识符（字母/下划线开头，只含字母数字下划线）：" + projectName);
    }
    if (fs.existsSync(targetDir) && request.overwrite !== true && fs.readdirSync(targetDir).length > 0) {
        return fail("目标目录不是空的：" + targetDir + "。换一个目录，或显式 overwrite=true。");
    }
    const template = await ensureCmsisTemplate({
        ...(request.mcu === undefined ? {} : { mcu: request.mcu }),
        ...(request.family === undefined ? {} : { family: request.family }),
        ...(request.env === undefined ? {} : { env: request.env }),
        ...(request.fetchImpl === undefined ? {} : { fetchImpl: request.fetchImpl }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
        ...(request.download === undefined ? {} : { download: request.download }),
    });
    if (!template.ok)
        return fail(template.message);
    const choice = resolveStartupChoice({ ...(request.mcu === undefined ? {} : { mcu: request.mcu }), ...(request.family === undefined ? {} : { family: request.family }) });
    if (choice === null || cmsisTemplatePlan(choice) === null)
        return fail("内部错误：缓存条目对应的下载清单没了（" + template.family + "）。");
    const spec = CMSIS_FAMILIES[template.family];
    if (spec === undefined)
        return fail("内部错误：这一代没有设备头规格（" + template.family + "）。");
    const familyDir = spec.deviceDefinePrefix + "xx";
    const regTpl = registerTemplateDir();
    const halTpl = templateDir();
    if (!fs.existsSync(regTpl))
        return fail("插件模板目录缺失：" + regTpl + "（重新安装插件）");
    fs.mkdirSync(path.join(targetDir, "Core", "Src"), { recursive: true });
    fs.mkdirSync(path.join(targetDir, "Core", "Inc"), { recursive: true });
    // 1) 寄存器版 CMakeLists：替换四个占位符
    const replacements = {
        __PROJECT_NAME__: projectName,
        __FAMILY_DIR__: familyDir,
        __STARTUP_FILE__: template.startup,
        __DEVICE_DEFINE__: template.deviceDefine,
    };
    const fill = (text) => {
        let out = text;
        for (const [key, value] of Object.entries(replacements))
            out = out.split(key).join(value);
        return out;
    };
    fs.writeFileSync(path.join(targetDir, "CMakeLists.txt"), fill(fs.readFileSync(path.join(regTpl, "CMakeLists.txt"), "utf8")), "utf8");
    // 2) 寄存器版 main.c（PC13 蓝丸示例，无占位符）
    fs.writeFileSync(path.join(targetDir, "Core", "Src", "main.c"), fs.readFileSync(path.join(regTpl, "Core", "Src", "main.c"), "utf8"), "utf8");
    // 3) 与 HAL 无关的公共文件：工具链 / presets / 链接脚本 / .gitignore
    let templateFiles = 2;
    for (const rel of SHARED_TEMPLATE_FILES) {
        const source = path.join(halTpl, rel);
        if (!fs.existsSync(source))
            return fail("插件模板缺文件：" + source + "（重新安装插件）");
        const dest = path.join(targetDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(source, dest);
        templateFiles += 1;
    }
    // 4) CMSIS：缓存条目里的 Drivers 整棵拷进工程（与 HAL 工程布局一致）
    const driversSrc = path.join(template.entryDir, "Drivers");
    if (!fs.existsSync(driversSrc))
        return fail("缓存的模板目录不完整（缺 Drivers）：" + template.entryDir + "。删掉它再试一次会重新下载。");
    fs.cpSync(driversSrc, path.join(targetDir, "Drivers"), { recursive: true });
    const driverFiles = countFiles(path.join(targetDir, "Drivers"));
    const warnings = [
        "模板里的 LED 是蓝丸的 PC13；换板子改 Core/Src/main.c 顶部的 LED_PORT / LED_PIN。",
        "寄存器版没有 .ioc：不需要 CubeMX，也不需要固件包；要换成 HAL 版就用 stm32_project_create route=hal。",
    ];
    if (template.cacheHit)
        warnings.push("这次用的是缓存模板（" + template.entryDir + "），没有联网。");
    else
        warnings.push("模板已下载到缓存（" + template.entryDir + "），以后再建工程不联网。");
    return {
        ok: true,
        targetDir,
        projectName,
        route: "register",
        mcu,
        family: template.family,
        startup: template.startup,
        deviceDefine: template.deviceDefine,
        cacheRoot: template.cacheRoot,
        cacheHit: template.cacheHit,
        templateFiles,
        driverFiles,
        durationMs: Date.now() - startedAt,
        warnings,
        message: "寄存器版工程已建好（" + String(templateFiles) + " 个工程文件 + " + String(driverFiles) + " 个 CMSIS 文件）：" + targetDir,
    };
}
