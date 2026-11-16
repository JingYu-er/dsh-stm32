import { readFileSync, writeFileSync } from "node:fs";

const notes = "docs/development-notes.md";
let text = readFileSync(notes, "utf8");
const from = text.indexOf("### 一百七十八、原理图编辑");
const end = text.indexOf("### 一百七十七、", from);
if (from < 0 || end < 0) throw new Error("anchor");

const addendum = `**补记（S170.1）：这一版把编辑区撤了，并修掉一处整页空白**

面板上的「选两个引脚连起来」那排下拉，用户反馈是反向体验——改图应该在他的 KiCad 里做，而不是在插件里再学一套。所以编辑区连同它的 hook 一并撤掉，指令层与 `stm32_sch_edit` 留在工具侧（模型可直接用），界面不再出现。

同时修掉一个真 bug：S169 的面板补丁引用了 \`D32_BUTTON\`，但这个常量从来没定义过，\`电路设计\` 页一渲染就 \`ReferenceError\`，整棵子树被卸载——表现就是「点进去什么也不显示」。补上常量，并加一条静态守卫测试：面板源码里出现的每个 \`D32_*\` 都必须在源码里有 \`const\` 定义，缺一个就失败。这类错误 React 不会在编译期报，只能靠「引用了就定义过」的机械检查。

`;

text = text.slice(0, end) + addendum + text.slice(end);
writeFileSync(notes, text);
console.log("note ok");

const guide = "docs/reading-guide.md";
let g = readFileSync(guide, "utf8");
g = g.replace("| 单测 | 88 个套件 / 1283 pass / 0 fail（含原理图 22 条、ECAD 57 条", "| 单测 | 88 个套件 / 1284 pass / 0 fail（含原理图 24 条、ECAD 57 条");
g = g.replace("| 客户端 | `client/client.js` 6982 行（手写，不经 tsc） |", "| 客户端 | `client/client.js` 6891 行（手写，不经 tsc） |");
g = g.replace("| 包体 | 2248.6 KB / 371 文件 / 解包 16826.9 KB（护栏上限 3906.3 KB） |", "| 包体 | 2246.3 KB / 371 文件 / 解包 16815.6 KB（护栏上限 3906.3 KB） |");
writeFileSync(guide, g);
console.log("guide ok");
