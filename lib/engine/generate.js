/**
 * L2：generate —— 无头跑 STM32CubeMX 生成代码，并把产物搬进工程结构。
 *
 * 一次调用做四件事（顺序固定）：
 *   1) 解析 .ioc / CubeMX 安装位置 / 生成布局；
 *   2) 单飞锁 + 写脚本，跑 java -jar STM32CubeMX.exe -q <script>（3–4 分钟）；
 *   3) 用 CubeMX 日志判定成功与否（失败一个字节都不写工程）；
 *   4) 成功才落位：Src/Inc → Core/Src、Core/Inc，搬运 USER CODE、备份被覆盖的文件。
 *
 * 这里不做工具注册、不做 job 管理，只接收 onProgress 回调，便于在终端直接跑。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { describeSearchScope, resolveSearchConfig } from "../data/search-roots.js";
import { buildGenerateScript, parseGenerateLog } from "./generate-script.js";
import { cacheHit, cacheKeyFor, entryFromFiles, readCache, writeCache } from "./generate-cache.js";
import { cubeMxUserHome, needsThirdpartyPacks, parkThirdpartyDb } from "./thirdparty.js";
import { listGeneratedFiles, mapGeneratedPath } from "./layout.js";
import { canMergeUserCode, mergeUserCode } from "./usercode-merge.js";
import { runStreaming } from "./subprocess-runner.js";
/** 工程内保存插件自身状态（锁、备份、临时脚本）的目录。 */
export const STATE_DIR = ".dsh-stm32";
function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}
function fail(request, message, extra = {}) {
    return {
        ok: false,
        projectDir: resolve(request.projectDir),
        iocPath: "",
        layout: request.layout === undefined || request.layout === "auto" ? "coupled" : request.layout,
        durationMs: 0,
        skipped: false,
        cacheKey: "",
        thirdparty: { parked: false, detail: "" },
        verdict: { ok: false, successLine: "", errors: [], knownNoise: [] },
        script: "",
        command: "",
        files: [],
        backupDir: "",
        message,
        notes: [],
        logTail: "",
        ...extra,
    };
}
/** 在工程根目录里找唯一的 .ioc。 */
export function findIocFile(projectDir) {
    if (!existsSync(projectDir))
        return null;
    const names = readdirSync(projectDir).filter((name) => name.toLowerCase().endsWith(".ioc"));
    if (names.length !== 1)
        return null;
    return join(projectDir, names[0]);
}
/**
 * 推断生成布局：现有 main.c 里出现形如 USER CODE BEGIN MX_GPIO_Init_1 的标签
 * 说明工程用的是"外设初始化并入 main.c"的耦合布局（ST VS Code 扩展默认）。
 */
export function detectLayout(projectDir) {
    const mainC = join(projectDir, "Core", "Src", "main.c");
    if (!existsSync(mainC))
        return "coupled";
    const text = readFileSync(mainC, "utf8");
    return /\/\* USER CODE BEGIN MX_[A-Za-z0-9_]+_1 \*\//u.test(text) ? "coupled" : "per-ip";
}
function acquireLock(projectDir, purpose) {
    const dir = join(projectDir, STATE_DIR);
    mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "lock.json");
    if (existsSync(lockPath)) {
        try {
            const info = JSON.parse(readFileSync(lockPath, "utf8"));
            const age = Date.now() - info.startedAt;
            if (age < 30 * 60 * 1000) {
                return {
                    error: "已有任务占用 CubeMX 单飞锁：" +
                        String(info.purpose) +
                        "（pid " +
                        String(info.pid) +
                        "，开始于 " +
                        new Date(info.startedAt).toLocaleString() +
                        "）。CubeMX 会写用户级数据库，不能并发；等它结束或删除 " +
                        lockPath +
                        " 后重试。",
                };
            }
        }
        catch {
            // 锁文件损坏按陈旧处理
        }
    }
    const info = { pid: process.pid, startedAt: Date.now(), purpose };
    writeFileSync(lockPath, JSON.stringify(info, null, 1), "utf8");
    return {
        release: () => {
            try {
                rmSync(lockPath, { force: true });
            }
            catch {
                // 释放失败不影响结论
            }
        },
    };
}
function cubeMxLaunch(cubeMxRoots) {
    for (const root of cubeMxRoots) {
        const java = root + "/jre/bin/java.exe";
        const jar = root + "/STM32CubeMX.exe";
        if (existsSync(java) && existsSync(jar))
            return { java, jar };
    }
    return null;
}
function tail(text, maxLines) {
    const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
    return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}
function backupFile(projectDir, backupRoot, relPath) {
    const source = join(projectDir, relPath);
    const target = join(backupRoot, relPath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
}
/** 落位：把生成物搬到工程结构里，搬运 USER CODE，备份被覆盖的文件。 */
function applyGeneratedFiles(projectDir, generated, backupRoot, dryRun) {
    const files = [];
    const notes = [];
    for (const source of generated) {
        const target = mapGeneratedPath(source);
        if (target === null) {
            notes.push("跳过不属于工程结构的生成物：" + source);
            continue;
        }
        const sourceAbs = join(projectDir, source);
        const targetAbs = join(projectDir, target);
        const newText = readFileSync(sourceAbs, "utf8");
        const existing = existsSync(targetAbs);
        if (!existing) {
            files.push({ source, target, action: dryRun ? "would-write" : "created", preserved: [], droppedLabels: [] });
            if (!dryRun) {
                mkdirSync(dirname(targetAbs), { recursive: true });
                writeFileSync(targetAbs, newText, "utf8");
            }
            continue;
        }
        const oldText = readFileSync(targetAbs, "utf8");
        if (!canMergeUserCode(newText)) {
            files.push({ source, target, action: "skipped-no-user-code-markers", preserved: [], droppedLabels: [] });
            notes.push(target + " 的新内容没有 USER CODE 标记，未覆盖（旧文件保持原样）");
            continue;
        }
        const merged = mergeUserCode(oldText, newText);
        files.push({
            source,
            target,
            action: dryRun ? "would-write" : "overwritten",
            preserved: merged.preserved,
            droppedLabels: merged.droppedLabels,
        });
        if (merged.droppedLabels.length > 0) {
            notes.push(target + " 里这些 USER CODE 标签在新生成内容中不存在，内容未搬运：" + merged.droppedLabels.join(", "));
        }
        if (!dryRun) {
            backupFile(projectDir, backupRoot, target);
            mkdirSync(dirname(targetAbs), { recursive: true });
            writeFileSync(targetAbs, merged.merged, "utf8");
        }
    }
    return { files, notes };
}
/**
 * 删掉 CubeMX 写到工程根的临时产物（Src/、Inc/）。
 *
 * 只删本次搬运过的文件，然后尝试删空目录——绝不 recursive 删除整个 Src/，
 * 因为有的工程本来就用 Src/ 当源码目录（例如 demo\_scratch）。
 */
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * 删空目录，带重试。
 *
 * Windows 上刚被 rm 的文件会先进 delete-pending 状态：目录此刻仍算非空，
 * `rmdir` 报 ENOTEMPTY；等占用它的句柄（CubeMX 的 JVM、杀毒扫描等）关掉后目录才真的空。
 * 所以这里轮询几次，而不是一次失败就留一堆空目录在工程根里。
 */
function removeDirIfEmpty(dir, attempts = 20, delayMs = 500) {
    let lastCode = "";
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            // 必须是 rmdirSync：rmSync 对目录即使 recursive:false 也报 ERR_FS_EISDIR（之前 Src/Inc 删不掉就是它）。
            rmdirSync(dir);
            return null;
        }
        catch (error) {
            lastCode = error.code ?? "UNKNOWN";
            if (lastCode === "ENOENT")
                return null;
        }
        // 实测：CubeMX 的 JVM 退出后还要再持有一会儿句柄，刚删完文件的目录会短时间删不掉（EBUSY/EPERM/ENOTEMPTY）。
        sleepSync(delayMs);
    }
    return lastCode;
}
function cleanupGenerated(projectDir, generated) {
    const notes = [];
    const dirs = new Set();
    for (const source of generated) {
        const abs = join(projectDir, source);
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                rmSync(abs, { force: true });
                break;
            }
            catch {
                // 文件被占用（delete-pending）：稍等再试，仍失败就留着，下轮会被覆盖
                sleepSync(250);
            }
        }
        dirs.add(dirname(abs));
    }
    const leftovers = [];
    for (const dir of dirs) {
        const code = removeDirIfEmpty(dir);
        if (code !== null)
            leftovers.push(relative(projectDir, dir) + "（" + code + "）");
    }
    for (const name of ["Src", "Inc"]) {
        const dir = join(projectDir, name);
        if (!existsSync(dir))
            continue;
        const code = removeDirIfEmpty(dir);
        if (code !== null && !leftovers.some((item) => item.startsWith(name + "（")))
            leftovers.push(name + "（" + code + "）");
    }
    if (leftovers.length > 0) {
        notes.push("生成用的临时目录没删干净（可能仍被 CubeMX 进程占用，可稍后手动删）：" + leftovers.join(", "));
    }
    return notes;
}
export async function runGenerate(subprocess, request) {
    const projectDir = resolve(request.projectDir);
    const iocPath = request.iocPath === undefined ? findIocFile(projectDir) : resolve(projectDir, request.iocPath);
    if (iocPath === null || !existsSync(iocPath)) {
        return fail(request, "在 " + projectDir + " 里找不到唯一的 .ioc 文件；请用 iocPath 指定");
    }
    const layout = request.layout === undefined || request.layout === "auto" ? detectLayout(projectDir) : request.layout;
    const config = resolveSearchConfig(process.env, request.cubeMxRoots === undefined ? {} : { cubeMxRoots: request.cubeMxRoots });
    const launch = cubeMxLaunch(config.cubeMxRoots);
    if (launch === null) {
        return fail(request, "找不到可无头调用的 STM32CubeMX（需要 <root>/jre/bin/java.exe 与 <root>/STM32CubeMX.exe）；查过 " +
            describeSearchScope(config.cubeMxRoots) +
            "；可用 STM32_CUBEMX_ROOT 指定安装根，或把 STM32CubeMX 装到这些位置之一");
    }
    const iocText = readFileSync(iocPath, "utf8");
    const cacheKey = cacheKeyFor(iocText, launch.java, launch.jar, layout);
    const stateDir = join(projectDir, STATE_DIR);
    const enteredAt = Date.now();
    const progress = request.onProgress ?? (() => undefined);
    let skipMiss = "";
    // 先看缓存：.ioc、CubeMX 版本、布局都没动且产物 hash 全对 → 一秒都不用等。
    if (request.skipIfUnchanged !== false) {
        const hit = cacheHit(readCache(stateDir), cacheKey.key, projectDir);
        if (hit.hit && hit.entry !== null) {
            const cached = hit.entry;
            return {
                ok: true,
                projectDir,
                iocPath,
                layout,
                durationMs: Date.now() - enteredAt,
                skipped: true,
                cacheKey: cacheKey.key,
                thirdparty: { parked: false, detail: "未探测（本次跳过 CubeMX）" },
                verdict: { ok: true, successLine: "（跳过 CubeMX：复用上次生成结果）", errors: [], knownNoise: [] },
                script: "",
                command: "",
                files: cached.files.map((file) => ({
                    source: file.target,
                    target: file.target,
                    action: "unchanged-cached",
                    preserved: [],
                    droppedLabels: [],
                })),
                backupDir: "",
                message: "跳过 CubeMX：.ioc、CubeMX 版本与布局都没变，且 " +
                    String(cached.files.length) +
                    " 个产物 hash 全部一致（直接复用 " +
                    new Date(cached.createdAt).toLocaleString() +
                    " 的生成结果，耗时 0 s）",
                notes: [
                    "想强制重新生成就传 skipIfUnchanged=false（会再跑一次 CubeMX，3–4 分钟）。",
                    "缓存文件：.dsh-stm32/" + "generate-cache.json" + "；删掉它等效于强制重跑。",
                ],
                logTail: "",
            };
        }
        skipMiss = hit.reason;
    }
    const lock = acquireLock(projectDir, "generate " + basename(iocPath));
    if ("error" in lock)
        return fail(request, lock.error, { iocPath, layout });
    // 第三方包索引：没有 X-CUBE 就临时停放，省掉两次 159 包枚举（实测约 25 s）。
    const thirdparty = { parked: false, detail: "" };
    let park = null;
    const parkNotes = [];
    // 判定靠包目录（src/engine/xcube-catalog.ts）+ 本机 pdsc 索引：认得出用的是什么包，也说得出本机有没有。
    const home = cubeMxUserHome(process.env);
    if (request.thirdpartyPacks === "keep") {
        thirdparty.detail = "thirdpartyPacks=keep：原样加载第三方包索引";
    }
    else {
        const pdscDir = home === null ? undefined : home + "/thirdparties/pdsc";
        const decision = needsThirdpartyPacks(iocText, pdscDir === undefined ? {} : { pdscDir });
        parkNotes.push(...decision.warnings);
        if (decision.needed) {
            thirdparty.detail = "保留第三方包索引：" + decision.reason;
        }
        else if (home === null) {
            thirdparty.detail = "无法确定 CubeMX 用户目录（USERPROFILE/HOME 为空），未停放第三方包索引";
        }
        else {
            const parked = parkThirdpartyDb(home + "/thirdparties");
            if (parked.ok) {
                park = parked;
                thirdparty.parked = true;
                thirdparty.detail = parked.detail + "；判定依据：" + decision.reason;
            }
            else {
                thirdparty.detail = parked.detail;
            }
        }
    }
    if (park !== null)
        progress("第三方包索引：" + thirdparty.detail);
    const stamp = nowStamp();
    const tmpDir = join(stateDir, "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const scriptPath = join(tmpDir, "gen-" + stamp + ".txt");
    const script = buildGenerateScript(iocPath.replace(/\\/g, "/"), projectDir.replace(/\\/g, "/"), layout);
    writeFileSync(scriptPath, script, "utf8");
    const argv = [launch.java, "-jar", launch.jar, "-q", scriptPath];
    const command = argv.map((part) => (part.includes(" ") ? '"' + part + '"' : part)).join(" ");
    const startedAt = Date.now();
    if (skipMiss !== "")
        progress("未跳过 CubeMX：" + skipMiss);
    progress("使用布局：" + (layout === "coupled" ? "coupled（外设初始化并入 main.c）" : "per-ip（每外设一对 .c/.h）"));
    progress("脚本：" + scriptPath);
    progress("命令：" + command);
    let outcome;
    try {
        outcome = await runStreaming(subprocess, {
            argv,
            cwd: projectDir,
            timeoutMs: request.timeoutMs ?? 600_000,
            maxBytes: 2 * 1024 * 1024,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            onOutput: (stream, text) => {
                for (const line of text.split(/\r?\n/u)) {
                    if (line.trim() !== "")
                        progress((stream === "stderr" ? "! " : "") + line.trim().slice(0, 300));
                }
            },
            onHeartbeat: (elapsed) => progress("…CubeMX 运行 " + String(Math.round(elapsed / 1000)) + " s（启动通常需要 90–150 s）"),
        });
    }
    finally {
        lock.release();
        if (park !== null) {
            // CubeMX 进程已经退出，这里把第三方包索引改回去；失败了要让人看见。
            for (const note of park.restore())
                parkNotes.push("! " + note);
        }
    }
    const log = outcome.stdout + "\n" + outcome.stderr;
    const verdict = parseGenerateLog(log);
    const durationMs = Date.now() - startedAt;
    // 失败路径也要把「第三方包索引」的判定与缺包警告带出去：CubeMX 报缺包时，
    // 我们自己那条"本机没有这个包"恰恰是最有用的信息，不能只在成功时给。
    const failureNotes = [];
    if (thirdparty.detail !== "")
        failureNotes.push("第三方包索引：" + thirdparty.detail);
    failureNotes.push(...parkNotes);
    const baseReport = {
        projectDir,
        iocPath,
        layout,
        durationMs,
        skipped: false,
        cacheKey: cacheKey.key,
        thirdparty,
        verdict,
        notes: failureNotes,
        script,
        command,
        logTail: tail(log, 25),
    };
    if (outcome.spawnError !== null) {
        return fail(request, "CubeMX 启动失败：" + outcome.spawnError, baseReport);
    }
    if (outcome.aborted) {
        // 取消（宿主 signal / 用户中断）：CubeMX 可能已经写了一部分 Src/Inc，先清掉再返回，别留半成品。
        const partial = [...listGeneratedFiles(projectDir, "Src"), ...listGeneratedFiles(projectDir, "Inc")];
        const cleaned = partial.length === 0 ? [] : cleanupGenerated(projectDir, partial);
        return {
            ...fail(request, "已取消：CubeMX 生成被中断，半成品已清理（" + String(partial.length) + " 个文件）" + (cleaned.length === 0 ? "" : "；" + cleaned[0]), baseReport),
            ok: false,
        };
    }
    if (outcome.timedOut) {
        return { ...fail(request, "CubeMX 生成超时", baseReport), ok: false };
    }
    if (!verdict.ok) {
        return {
            ...fail(request, "CubeMX 未报告成功" + (verdict.errors.length === 0 ? "" : "：" + verdict.errors[0]), baseReport),
            ok: false,
        };
    }
    const generated = [...listGeneratedFiles(projectDir, "Src"), ...listGeneratedFiles(projectDir, "Inc")];
    if (generated.length === 0) {
        return fail(request, "CubeMX 报告成功但没有产生任何 Src/Inc 文件", baseReport);
    }
    const backupRoot = join(stateDir, "backups", stamp);
    const applied = applyGeneratedFiles(projectDir, generated, backupRoot, request.dryRun === true);
    const notes = [...applied.notes];
    if (verdict.knownNoise.length > 0) {
        notes.push("CubeMX 噪音 " + String(verdict.knownNoise.length) + " 条（与本芯片无关，已忽略）");
    }
    if (request.dryRun !== true)
        notes.push(...cleanupGenerated(projectDir, generated));
    if (thirdparty.detail !== "")
        notes.push("第三方包索引：" + thirdparty.detail);
    notes.push(...parkNotes);
    if (request.dryRun !== true) {
        // 记下这次产物：下次 .ioc 没变就能直接跳过 CubeMX（3–4 分钟 → 0 s）。
        const entry = entryFromFiles(cacheKey.key, cacheKey.iocSha256, cacheKey.cubeMxStamp, layout, projectDir, applied.files.filter((file) => file.action !== "skipped-no-user-code-markers").map((file) => file.target));
        if (entry === null) {
            notes.push("没能写生成缓存（有产物取不到 hash），下次仍会跑 CubeMX");
        }
        else {
            try {
                writeCache(stateDir, entry);
            }
            catch (error) {
                notes.push("没能写生成缓存：" + String(error.message));
            }
        }
    }
    return {
        ok: true,
        ...baseReport,
        files: applied.files,
        backupDir: request.dryRun === true ? "" : backupRoot,
        message: "生成成功，" +
            String(applied.files.length) +
            " 个文件落位（" +
            String(applied.files.filter((file) => file.action === "overwritten").length) +
            " 个覆盖、保活 USER CODE 标签 " +
            String(applied.files.reduce((sum, file) => sum + file.preserved.length, 0)) +
            " 个）",
        notes,
    };
}
