/**
 * L1：.ioc 解析（只读）。
 *
 * .ioc 是 CubeMX 的纯文本工程配置：每行 key=value，值里的 ":" 写成 "\:"。
 * 这里只做确定性解析与派生判断，不写盘、不起进程，便于单测与审计。
 *
 * 派生信息里最重要的是"调试口是否启用 Serial Wire"——.ioc 里没有 SYS 调试模式
 * 会让 CubeMX 生成 __HAL_AFIO_REMAP_SWJ_DISABLE()，固件一上电就关掉 SWD，
 * 烧录后再也连不上（本项目实测踩过，见规格书 §8）。
 */
const JTAG_SIGNALS = new Set(["SYS_JTMS-SWDIO", "SYS_JTCK-SWCLK", "SYS_JTDI", "SYS_JTDO-SWO", "SYS_NJTRST"]);
/** 解码 CubeMX 在值里写的转义（实测只有 ":"）。 */
export function decodeIocValue(raw) {
    return raw.replace(/\\([:\\])/gu, "$1");
}
/** 把 .ioc 文本拆成有序键值对。注释（# 开头）与空行忽略，重复键后者覆盖前者。 */
export function parseIocEntries(text) {
    const entries = new Map();
    for (const rawLine of text.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#"))
            continue;
        const eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        entries.set(line.slice(0, eq).trim(), decodeIocValue(line.slice(eq + 1).trim()));
    }
    return entries;
}
function toInt(raw) {
    if (raw === undefined)
        return null;
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) ? value : null;
}
function pinKind(signal) {
    if (signal.startsWith("GPIO_"))
        return "gpio";
    if (JTAG_SIGNALS.has(signal))
        return "debug";
    if (signal.startsWith("RCC_"))
        return "clock";
    if (signal.startsWith("SYS_VS_") || signal.startsWith("VP_"))
        return "virtual";
    return "other";
}
/**
 * 解析 .ioc 全文。
 * @param text 文件内容
 * @param path 仅用于回填 summary.path
 */
export function summarizeIoc(text, path = "") {
    const entries = parseIocEntries(text);
    const pins = [];
    const pinCount = toInt(entries.get("Mcu.PinsNb")) ?? 0;
    for (let index = 0; index < pinCount; index += 1) {
        const pin = entries.get("Mcu.Pin" + String(index));
        if (pin === undefined)
            continue;
        const signal = entries.get(pin + ".Signal") ?? "";
        pins.push({
            pin,
            signal,
            label: entries.get(pin + ".GPIO_Label") ?? "",
            mode: entries.get(pin + ".Mode") ?? "",
            locked: (entries.get(pin + ".Locked") ?? "false").toLowerCase() === "true",
            kind: pinKind(signal),
        });
    }
    const peripherals = [];
    const ipCount = toInt(entries.get("Mcu.IPNb")) ?? 0;
    for (let index = 0; index < ipCount; index += 1) {
        const name = entries.get("Mcu.IP" + String(index));
        if (name !== undefined)
            peripherals.push(name);
    }
    const nvicEnabled = [];
    for (const [key, value] of entries) {
        if (!key.startsWith("NVIC.") || !key.endsWith("_IRQn"))
            continue;
        if (value.trim().toLowerCase().startsWith("true"))
            nvicEnabled.push(key.slice(5));
    }
    const settings = {
        targetToolchain: entries.get("ProjectManager.TargetToolchain") ?? "",
        projectName: entries.get("ProjectManager.ProjectName") ?? "",
        mainLocation: entries.get("ProjectManager.MainLocation") ?? "",
        coupleFile: (entries.get("ProjectManager.CoupleFile") ?? "false").toLowerCase() === "true",
        keepUserCode: (entries.get("ProjectManager.KeepUserCode") ?? "true").toLowerCase() === "true",
        heapSize: entries.get("ProjectManager.HeapSize") ?? "",
        stackSize: entries.get("ProjectManager.StackSize") ?? "",
        compilerOptimize: entries.get("ProjectManager.CompilerOptimize") ?? "",
        firmwarePackage: entries.get("ProjectManager.FirmwarePackage") ?? "",
        mcuCubeVersion: entries.get("MxCube.Version") ?? "",
    };
    const clocks = {
        sysclkHz: toInt(entries.get("RCC.SYSCLKFreq_VALUE")),
        ahbHz: toInt(entries.get("RCC.AHBFreq_Value")),
        apb1Hz: toInt(entries.get("RCC.APB1Freq_Value")),
        apb2Hz: toInt(entries.get("RCC.APB2Freq_Value")),
        sysclkSource: entries.get("RCC.SYSCLKSource") ?? "",
        pllSource: entries.get("RCC.PLLSourceVirtual") ?? "",
        pllMul: entries.get("RCC.PLLMUL") ?? "",
        apb1Divider: entries.get("RCC.APB1CLKDivider") ?? "",
    };
    const debugPins = pins.filter((pin) => pin.kind === "debug");
    const serialWire = pins.some((pin) => pin.signal === "SYS_JTMS-SWDIO" || pin.mode === "Serial_Wire");
    const jtag = pins.some((pin) => pin.signal === "SYS_JTDI" || pin.mode === "JTAG");
    const warnings = [];
    if (!serialWire) {
        warnings.push("没有启用 Serial Wire 调试口（缺 SYS_JTMS-SWDIO/SYS_JTCK-SWCLK）：CubeMX 会生成 __HAL_AFIO_REMAP_SWJ_DISABLE()，烧录后 SWD 连不上，只能靠 BOOT0 进系统 bootloader 救回来。");
    }
    if (!settings.keepUserCode) {
        warnings.push("ProjectManager.KeepUserCode=false：重新生成会丢掉 USER CODE 区的内容。");
    }
    if (settings.targetToolchain !== "" && settings.targetToolchain !== "CMake") {
        warnings.push("TargetToolchain=" + settings.targetToolchain + "（不是 CMake）：生成的工程结构与 CMake 工程不同。");
    }
    if (settings.mainLocation !== "" && settings.mainLocation !== "Src" && settings.mainLocation !== "Core/Src") {
        warnings.push("MainLocation=" + settings.mainLocation + "：不是常见的 Src 或 Core/Src，落位时需要人工确认。");
    }
    if (settings.coupleFile) {
        warnings.push("CoupleFile=true：外设初始化与 main 分文件生成，USER CODE 标签集合会与 coupled 布局不同。");
    }
    return {
        path,
        mcu: {
            cpn: entries.get("Mcu.CPN") ?? "",
            name: entries.get("Mcu.Name") ?? "",
            family: entries.get("Mcu.Family") ?? "",
            package: entries.get("Mcu.Package") ?? "",
        },
        settings,
        pins,
        peripherals,
        nvicEnabled,
        debug: { serialWire, jtag, pins: debugPins.map((pin) => pin.pin), mode: debugPins[0]?.mode ?? "" },
        clocks,
        warnings,
        entryCount: entries.size,
    };
}
