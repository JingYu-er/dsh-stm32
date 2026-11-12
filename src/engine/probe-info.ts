/**
 * 探针信息（S41）：把「当前插着什么探针」讲清楚——类型、VID:PID、序列号、位置、该用哪份 interface 配置。
 *
 * 数据只来自 `pnputil /enum-devices /connected` 的 ASCII 段（中文系统字段名是 GBK，读出来是乱码，
 * 不参与匹配）。取不到的字段一律留空，由面板显示 `—`，不猜。
 */
import { parseProbeVidPid, preferredInterfaceConfig, type DetectedProbe } from "./doctor.js";
import { runCapture } from "./subprocess-runner.js";
import type { SubprocessService } from "../types.js";

/** pnputil 里的一条 USB 设备实例。 */
export interface ProbeInstance {
  vid: string;
  pid: string;
  /** `USB\VID_C251&PID_F001\ABCDEF` 的最后一段：纯十六进制串当序列号，带 `&` 的当位置（总线路径）。 */
  serial: string;
  location: string;
  instanceId: string;
  /** 带 `&MI_xx` 的是设备里的某个接口（HID / COM），序列号只认父设备那一条。 */
  isInterface: boolean;
}

export interface ProbeDetail extends DetectedProbe {
  serial: string;
  location: string;
}

export interface ProbeInfoReport {
  /** 有可用 SWD 探针（ST-LINK / J-Link / CMSIS-DAP / DAPLink）。 */
  present: boolean;
  probe: ProbeDetail | null;
  /** 其它 USB 设备（不是 SWD 探针），面板只列前几条。 */
  others: string[];
  interfaceCfg: string;
  interfaceWhy: string;
  /** pnputil 跑不了时的原因；正常为空串。 */
  error: string;
}

/** `USB\VID_C251&PID_F001\ABCDEF` → {vid,pid,serial,location}。 */
export function parseProbeInstances(text: string): ProbeInstance[] {
  const out: ProbeInstance[] = [];
  const seen = new Set<string>();
  // 真实 pnputil 里同一颗探针有三条：父设备 `\VID_C251&PID_F001\0001A0000000`，
  // 以及两个接口 `\VID_C251&PID_F001&MI_00\6&30b5aae7&0&0000`（COM）/ `&MI_02\...`（HID）。
  for (const matched of text.matchAll(/USB\\VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})(&MI_[0-9A-Fa-f]{2})?\\([^\s"']+)/giu)) {
    const vid = (matched[1] ?? "").toLowerCase();
    const pid = (matched[2] ?? "").toLowerCase();
    const iface = (matched[3] ?? "").toUpperCase();
    const suffix = (matched[4] ?? "").trim();
    const instanceId = "USB\\VID_" + vid.toUpperCase() + "&PID_" + pid.toUpperCase() + iface + "\\" + suffix;
    if (seen.has(instanceId)) continue;
    seen.add(instanceId);
    // 最后一段带 `&`（如 5&2c1a&0&1）是总线路径，换 USB 口就变，不能当身份。
    const isPath = suffix.includes("&");
    out.push({
      vid,
      pid,
      serial: isPath ? "" : suffix,
      location: isPath ? suffix : "",
      instanceId,
      isInterface: iface !== "",
    });
  }
  return out;
}

const SWD_KINDS = new Set(["st-link", "jlink", "cmsis-dap", "daplink"]);

/** 文本 → 探针报告（纯函数，单测直接喂样例）。 */
export function probeInfoFromText(text: string): ProbeInfoReport {
  const probes = parseProbeVidPid(text);
  const instances = parseProbeInstances(text);
  const details: ProbeDetail[] = probes.map((probe) => {
    // 序列号优先取父设备；只有接口条目时退回接口条目（串号留空、位置填总线路径）。
    const instance =
      instances.find((item) => item.vid === probe.vid && item.pid === probe.pid && !item.isInterface) ??
      instances.find((item) => item.vid === probe.vid && item.pid === probe.pid);
    return {
      ...probe,
      serial: instance?.serial ?? "",
      location: instance?.location ?? "",
    };
  });
  const swd = details.filter((probe) => SWD_KINDS.has(probe.kind));
  const picked = swd[0] ?? null;
  const choice = preferredInterfaceConfig(details);
  return {
    present: picked !== null,
    probe: picked,
    others: details.filter((probe) => probe !== picked).map((probe) => probe.label),
    interfaceCfg: picked === null ? "" : choice.cfg,
    interfaceWhy: picked === null ? "" : choice.why,
    error: "",
  };
}

export interface ProbeInfoDeps {
  subprocess: SubprocessService;
  signal?: AbortSignal;
}

/** 跑一次 pnputil 再解析；跑不了就返回 error，不抛。 */
export async function readProbeInfo(deps: ProbeInfoDeps): Promise<ProbeInfoReport> {
  try {
    const outcome = await runCapture(deps.subprocess, {
      argv: ["pnputil", "/enum-devices", "/connected"],
      timeoutMs: 10_000,
      maxBytes: 2 * 1024 * 1024,
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    });
    if (outcome.spawnError !== null || outcome.exitCode !== 0) {
      return {
        present: false,
        probe: null,
        others: [],
        interfaceCfg: "",
        interfaceWhy: "",
        error: "跑不了 pnputil /enum-devices（" + (outcome.spawnError ?? "退出码 " + String(outcome.exitCode)) + "）",
      };
    }
    return probeInfoFromText(outcome.stdout + "\n" + outcome.stderr);
  } catch (error) {
    return {
      present: false,
      probe: null,
      others: [],
      interfaceCfg: "",
      interfaceWhy: "",
      error: "探针信息读取异常终止（" + (error instanceof Error ? error.message : String(error)) + "）",
    };
  }
}
