/**
 * PDF 能力依赖的 poppler 工具（S117）。
 *
 * 为什么只认 poppler、不引 pymupdf：数据手册与原理图 PDF 的三种内容各有一条最短路径——
 * 文字与表格用 pdftotext（真实字符）、整页或局部图用 pdftoppm（渲染成 PNG 给人看）、
 * 矢量线段用 pdftocairo -svg。poppler 一个包同时提供这三个 CLI，且是纯 C++ 可执行文件，
 * 不需要往任何 Python 环境里装库。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
const NAMES = {
    pdftotext: ["pdftotext", "pdftotext.exe"],
    pdfinfo: ["pdfinfo", "pdfinfo.exe"],
    pdftoppm: ["pdftoppm", "pdftoppm.exe"],
};
function findIn(dir, names) {
    for (const name of names) {
        const full = join(dir, name);
        if (existsSync(full))
            return full;
    }
    return null;
}
/**
 * 定位 poppler。传入的目录按顺序尝试（调用方一般给 msys64 的 ucrt64/bin 等），
 * 全部缺失时返回可执行的中文错误，不抛异常。
 */
export function locatePoppler(dirs) {
    const tried = [];
    for (const dir of dirs) {
        if (dir === "")
            continue;
        tried.push(dir);
        const pdftotext = findIn(dir, NAMES.pdftotext);
        if (pdftotext === null)
            continue;
        const pdfinfo = findIn(dir, NAMES.pdfinfo);
        const pdftoppm = findIn(dir, NAMES.pdftoppm);
        if (pdfinfo === null || pdftoppm === null)
            continue;
        return { tools: { pdftotext, pdfinfo, pdftoppm, binDir: dir }, error: "" };
    }
    return {
        tools: null,
        error: "没有找到 poppler（pdftotext / pdfinfo / pdftoppm）：读数据手册与原理图 PDF 需要它。" +
            "安装：pacman -S --needed mingw-w64-ucrt-x86_64-poppler（在 MSYS2 里执行，装到 ucrt64/bin）；" +
            "装完运行 stm32_doctor 看缺件清单。" +
            (tried.length === 0 ? "" : "已查找目录：" + tried.join("、")),
    };
}
