// 验收脚本共用的小工具：复刻宿主 subprocess 契约（cwd 必填、collected.readFrom 偏移读取）、
// 目录复制、去时间戳日志。只给 test/ 下的 e2e 脚本用，不参与插件打包。
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export function makeSubprocess() {
  return {
    resolveExecutable(command) {
      return command;
    },
    spawn(spec) {
      // 宿主 subprocess 服务要求 cwd 必填，缺省会抛 includes 的 TypeError——这里照样复刻。
      if (typeof spec.cwd !== "string") throw new TypeError("Cannot read properties of undefined (reading 'includes')");
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const buffers = { stdout: "", stderr: "" };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffers.stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        buffers.stderr += chunk;
      });
      const done = new Promise((resolveDone, rejectDone) => {
        child.on("error", rejectDone);
        child.on("close", (code) => resolveDone({ exitCode: code, signal: null }));
      });
      const reader = (key) => ({
        readFrom(offset) {
          const text = buffers[key].slice(offset);
          return { text, nextOffset: buffers[key].length, lossy: false };
        },
      });
      spec.signal?.addEventListener("abort", () => child.kill(), { once: true });
      return {
        done,
        collected: { stdout: reader("stdout"), stderr: reader("stderr") },
        terminate() {
          child.kill();
        },
        waitForExit() {
          return done.catch(() => undefined);
        },
      };
    },
  };
}

export const log = (...parts) => console.log("[" + new Date().toISOString().slice(11, 19) + "]", ...parts);

/**
 * 把一份现成工程复制到目标目录（目标先清空）。返回目标路径。
 *
 * 不复制 build/：CMakeCache.txt 里记的是绝对路径，复制过来后 cmake 会报
 * "CMakeCache.txt directory ... is different"，而且 ninja 退出码是 0（假成功）。
 * 也不复制 .dsh-stm32/：锁与备份都属于原工程。
 */
export function freshCopy(source, target) {
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const skip = [join(source, "build"), join(source, ".dsh-stm32")];
  cpSync(source, target, {
    recursive: true,
    filter: (src) => !src.includes(".e2e") && !skip.includes(src),
  });
  return target;
}

/** 目录下的文件数（递归，跳过 .dsh-stm32 备份）。 */
export function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".dsh-stm32") continue;
      total += countFiles(full);
    } else if (statSync(full).isFile()) total += 1;
  }
  return total;
}
