// 把 src/data 下的 JSON 数据模块复制到 lib（tsc 只编译 .ts；npm files 只带 lib）。
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "data", "rm-topics");
const dest = join(root, "lib", "data", "rm-topics");
if (!existsSync(src)) {
  console.error("缺目录：" + src);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (!f.endsWith(".json")) continue;
  copyFileSync(join(src, f), join(dest, f));
  n += 1;
}
console.log("rm-topics: " + String(n) + " 个 JSON 已复制进 lib/data/rm-topics");
