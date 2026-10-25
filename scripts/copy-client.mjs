#!/usr/bin/env node
/**
 * 把浏览器端脚本从 client/ 原样复制到 lib/。
 *
 * 为什么不交给 tsc：client/client.js 是宿主客户端模块加载器直接执行的产物
 * （window.__ModuleLoader__.load(...)），不参与插件的 TS 类型世界；让 tsc
 * 去编译它只会多出 allowJs/outDir 一堆开关，还可能把 import 改写成 ESM，
 * 而加载器要的是那层自执行包装。所以构建脚本只做一次字节级复制。
 *
 * 为什么还要落一份到 lib/：package.json 的 exports["./client"] 指向
 * lib/client.js，宿主按包内路径取文件；npm 打包的 files 里也只带 lib。
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const source = resolve(projectRoot, "client", "client.js");
const target = resolve(projectRoot, "lib", "client.js");

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log("client/client.js -> lib/client.js");
