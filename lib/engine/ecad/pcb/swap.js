/**
 * 换封装（S182）：把一个位号换成 KiCad 官方库里的封装，保留位号、值、位置与网络。
 *
 * 为什么不手改文本：板子上的封装块结构多（焊盘、丝印、3D 模型、net 声明），
 * 手改容易丢网络；交给 pcbnew 的 FootprintLoad 解析库文件，再按「焊盘编号」把旧件
 * 的网络搬过去，与 KiCad 自己「从库更新封装」是同一套口径。
 *
 * 换封装会改焊盘尺寸与位置，附近走线不会跟着动——结果里如实报出焊盘尺寸变化，
 * 并提醒重布；不做自动删线，也不在换完之后假装板子还能直接生产。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runCapture } from "../../subprocess-runner.js";
export const EMPTY_SWAP = {
    ok: false,
    error: "",
    ref: "",
    from: "",
    to: "",
    applied: false,
    pads: 0,
    assigned: 0,
    lost: [],
    oldPad: { widthMm: 0, heightMm: 0 },
    newPad: { widthMm: 0, heightMm: 0 },
    modelBefore: "",
    modelAfter: "",
    notes: [],
};
/**
 * python 侧：读板 → 找旧件 → 从库加载新件 → 搬位号/值/位置/旋转/网络 → （apply 时）存盘。
 *
 * 只在 `apply` 时才 Remove + Add + SaveBoard；预演只回报会改什么。
 */
export const PCB_SWAP_SCRIPT = String.raw `
import json
import sys

import pcbnew


def mm(value):
    return round(value / 1000000.0, 4)


def first_pad_size(footprint):
    for pad in footprint.Pads():
        size = pad.GetSize()
        return {"widthMm": mm(size.x), "heightMm": mm(size.y)}
    return {"widthMm": 0.0, "heightMm": 0.0}


def pad_nets(footprint):
    nets = {}
    for pad in footprint.Pads():
        name = pad.GetNetname()
        if name:
            nets[pad.GetNumber()] = name
    return nets


def model_of(footprint):
    models = footprint.Models()
    if len(models) > 0:
        return models[0].m_Filename
    return ""


def main():
    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    result_file = sys.argv[2]
    board = pcbnew.LoadBoard(payload["board"])
    ref = payload["ref"]
    old = board.FindFootprintByReference(ref)
    if old is None:
        raise ValueError("板子上没有位号 " + ref)
    lib_id = payload["footprint"].split(":", 1)
    if len(lib_id) != 2:
        raise ValueError("footprint 要写成 Lib:Name")
    lib_dir = payload["footprintDir"] + "/" + lib_id[0] + ".pretty"
    new = pcbnew.FootprintLoad(lib_dir, lib_id[1])
    if new is None:
        raise ValueError("库里没有这个封装：" + payload["footprint"] + "（在 " + lib_dir + " 下找）")

    nets = pad_nets(old)
    by_name = board.GetNetInfo().NetsByName()
    new.SetPosition(old.GetPosition())
    new.SetOrientation(old.GetOrientation())
    new.SetReference(ref)
    new.SetValue(old.GetValue())
    assigned = 0
    lost = []
    for pad in new.Pads():
        name = nets.get(pad.GetNumber(), "")
        if name == "":
            continue
        if name in by_name:
            pad.SetNet(by_name[name])
            assigned += 1
        else:
            lost.append(pad.GetNumber())

    applied = bool(payload.get("apply"))
    if applied:
        board.Remove(old)
        board.Add(new)
        pcbnew.SaveBoard(payload["board"], board)

    old_id = old.GetFPID()
    old_name = str(old_id.GetLibItemName())
    old_lib = str(old_id.GetLibNickname())
    data = {
        "ref": ref,
        "from": (old_lib + ":" if old_lib else "") + old_name,
        "to": payload["footprint"],
        "applied": applied,
        "pads": len(list(new.Pads())),
        "assigned": assigned,
        "lost": lost,
        "oldPad": first_pad_size(old),
        "newPad": first_pad_size(new),
        "modelBefore": model_of(old),
        "modelAfter": model_of(new),
    }
    json.dump({"ok": True, "data": data}, open(result_file, "w", encoding="utf-8"))
    print(json.dumps({"ok": True, "data": data}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - 协议要求把任何异常变成一行 JSON
        message = str(error)
        sys.stdout.write(json.dumps({"ok": False, "error": {"kind": "FAILED_PRECONDITION", "message": message}}) + "\n")
        sys.exit(1)
`;
/** 预演与写入共用同一个脚本路径；内容变了才重写。 */
export function swapScriptPath() {
    return join(tmpdir(), "dsh-stm32-swap", "pcb_swap.py");
}
export function ensureSwapScript() {
    const file = swapScriptPath();
    const dir = dirname(file);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    if (!existsSync(file) || readFileSync(file, "utf8") !== PCB_SWAP_SCRIPT)
        writeFileSync(file, PCB_SWAP_SCRIPT, "utf8");
    return file;
}
export function parseSwapOutput(stdout) {
    const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().startsWith("{"));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(lines[index] ?? "");
            if (parsed.ok === true)
                return { ok: true, data: parsed.data ?? {}, error: "" };
            return { ok: false, data: null, error: parsed.error?.message ?? "换封装失败" };
        }
        catch {
            // 继续往前找
        }
    }
    return { ok: false, data: null, error: "换封装没有返回可解析的结果" };
}
/** 换封装：写 payload、跑脚本、把结果收成 SwapResult。 */
export async function runSwap(deps, request) {
    if (!existsSync(request.boardFile))
        return { ...EMPTY_SWAP, error: "板子不存在：" + request.boardFile };
    if (request.ref.trim() === "")
        return { ...EMPTY_SWAP, error: "ref 不能为空：给要换的位号，例如 U1" };
    const libId = request.footprint.trim();
    if (!libId.includes(":"))
        return { ...EMPTY_SWAP, error: "footprint 要写成 Lib:Name，例如 Package_QFP:LQFP-48_7x7mm_P0.5mm" };
    const script = ensureSwapScript();
    const stamp = String(Date.now());
    const payloadFile = join(tmpdir(), "dsh-stm32-swap", "payload-" + stamp + ".json");
    const resultFile = join(tmpdir(), "dsh-stm32-swap", "result-" + stamp + ".json");
    writeFileSync(payloadFile, JSON.stringify({ board: request.boardFile, ref: request.ref.trim(), footprint: libId, footprintDir: request.footprintDir, apply: request.apply }), "utf8");
    const outcome = await runCapture(deps.subprocess, {
        argv: [deps.python, script, payloadFile, resultFile],
        timeoutMs: deps.timeoutMs ?? 120_000,
    });
    const parsed = parseSwapOutput(outcome.stdout);
    if (!parsed.ok || parsed.data === null) {
        const stderrTail = outcome.stderr.trim() !== "" ? outcome.stderr.trim().split(/\r?\n/u).slice(-3).join(" / ") : "";
        // 脚本崩在 Python 层时 stdout 什么都没有，真正的原因在 stderr；只在解析失败且没给具体错误时才用 stderr。
        const detail = parsed.error !== "" && !parsed.error.includes("没有返回可解析") ? parsed.error : (stderrTail !== "" ? stderrTail : "退出码 " + String(outcome.exitCode));
        return { ...EMPTY_SWAP, ref: request.ref, to: libId, applied: false, error: detail };
    }
    const data = parsed.data;
    const oldPad = (data["oldPad"] ?? {});
    const newPad = (data["newPad"] ?? {});
    const oldSize = { widthMm: Number(oldPad.widthMm ?? 0), heightMm: Number(oldPad.heightMm ?? 0) };
    const newSize = { widthMm: Number(newPad.widthMm ?? 0), heightMm: Number(newPad.heightMm ?? 0) };
    const notes = [];
    if (Math.abs(oldSize.widthMm - newSize.widthMm) > 1e-6 || Math.abs(oldSize.heightMm - newSize.heightMm) > 1e-6) {
        notes.push("焊盘尺寸变了：" + String(oldSize.widthMm) + "×" + String(oldSize.heightMm) + " → " + String(newSize.widthMm) + "×" + String(newSize.heightMm) +
            " mm；这个器件附近的走线要重布，DRC 会报 clearance。");
    }
    if (Array.isArray(data["lost"]) && data["lost"].length > 0) {
        notes.push("有 " + String(data["lost"].length) + " 个焊盘的网络在板上找不到：" + data["lost"].slice(0, 8).join("、"));
    }
    if (data["modelAfter"] === "")
        notes.push("新封装没有引用 3D 模型：3D 预览里这个器件还是空着。");
    return {
        ok: true,
        error: "",
        ref: String(data["ref"] ?? request.ref),
        from: String(data["from"] ?? ""),
        to: String(data["to"] ?? libId),
        applied: data["applied"] === true,
        pads: Number(data["pads"] ?? 0),
        assigned: Number(data["assigned"] ?? 0),
        lost: Array.isArray(data["lost"]) ? data["lost"].map((item) => String(item)) : [],
        oldPad: oldSize,
        newPad: newSize,
        modelBefore: String(data["modelBefore"] ?? ""),
        modelAfter: String(data["modelAfter"] ?? ""),
        notes,
    };
}
