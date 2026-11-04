/**
 * L2：直接读 STM32CubeMX 安装自带的 db（只查询，不复制、不落盘）。
 *
 * 为什么这么做：用户要求「能在 db 查到的，只写查询逻辑」。CubeMX 安装目录里的
 * db/mcu/*.xml 就是芯片事实（引脚、Signal、IP 实例、最高频率），
 * db/mcu/IP/*_Modes.xml 就是各 IP 的合法模式名，db/package.xml 是库版本。
 * 这些文件随用户的 CubeMX 版本变化，所以我们不在插件里内置副本，运行时按版本找。
 *
 * 结构（实测 DB.6.0.150）：
 *   db/package.xml                      → <PackDescription Release="DB.6.0.150"/>
 *   db/mcu/STM32F103C(8-B)Tx.xml        → <Mcu ... Package="LQFP48"> <Frequency>72</Frequency>
 *                                          <Pin Name="PA8" Position="29"><Signal Name="TIM1_CH1"/>…
 *                                          <IP ConfigFile="TIM-STM32F1xx" InstanceName="TIM3" Name="TIM1_8F1" Version="gptimer2_v1_x_Cube"/>
 *   db/mcu/IP/TIM1_8F1-gptimer2_v1_x_Cube_Modes.xml → <RefMode Name="PWM Generation1 No Output" …/>
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface CubemxDb {
  /** db 根目录（含 package.xml 与 mcu/）。 */
  root: string;
  /** DB 版本，例如 DB.6.0.150。 */
  version: string;
}

export interface CubemxPinFact {
  name: string;
  position: number;
  /** Signal 名 → 允许的 IO 模式（GPIO 的 IOModes；其它为空数组）。 */
  signals: Map<string, string[]>;
}

export interface CubemxIpFact {
  instanceName: string;
  name: string;
  version: string;
  configFile: string;
}

export interface CubemxMcuFacts {
  name: string;
  packageName: string;
  /** MHz。 */
  frequencyMhz: number;
  /**
   * 族（db 的 Family 属性，例如 STM32F1 / STM32L4+）。空串 = 老版本 db 没有这个属性
   * 或者文件里没写，调用方不要拿它猜型号。
   */
  family: string;
  /** 产品线（db 的 Line 属性，例如 STM32F103）。 */
  line: string;
  /**
 * 主内核（`<Core>`，例如 `Arm Cortex-M3`）。
 *
 * 实测 db `DB.6.0.150` 的 2019 个 MCU xml：**没有任何一个带 "/" 的双核写法**，只有大小写两种
 * （`Arm Cortex-M4` 362 / `ARM Cortex-M4` 157、`Arm Cortex-M7` 168 / `ARM Cortex-M7` 97、
 * `Arm Cortex-M33` 5 / `ARM Cortex-M33` 347；C0 是 `ARM Cortex-M0+`），且**只写主核**
 * （MP1 只写 `ARM Cortex-A7`、MP2 只写 `ARM Cortex-A35`，协处理核不出现）。另有 2 个老文件没有
 * `<Core>` 节点 → 内核为空串，调用方必须当成"不知道内核"处理，别猜。
 */
  core: string;
  /** RAM 总量（KiB）。 */
  ramKb: number;
  /** Flash 容量档（KiB，可能多档：同一 XML 覆盖多个容量）；空数组 = db 没写。 */
  flashKb: number[];
  /** 封装上引脚总数（db 的 IONb）。 */
  ioNb: number;
  /**
   * db 的 `ClockTree` 属性（例如 `STM32F2_F205-F207-F215-F217`、`STM32H5_128`）：
   * 时钟树定义在 `db/plugins/clock/<ClockTree>.xml`，里面的 `refParameter` 就是"由 CubeMX 自己算"的
   * 频率槽（`HSE_VALUE`、`EPOD_VALUE`…）。空串 = 老 db 没这个属性。
   */
  clockTree: string;
  pins: Map<string, CubemxPinFact>;
  ips: Map<string, CubemxIpFact>;
}

/** 读 <root>/db/package.xml 里的 Release。 */
function readDbVersion(dbRoot: string): string | null {
  const file = join(dbRoot, "package.xml");
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const match = /Release="(DB[^"]+)"/u.exec(text);
  return match === null ? null : (match[1] as string);
}

/**
 * 定位要用的 db：优先安装目录，其次用户目录下的历史下载库。
 * wantedVersion 为空时用安装目录那份（CubeMX 自己也是这么选的）。
 */
export function locateCubemxDb(roots: string[], wantedVersion = ""): CubemxDb | null {
  const candidates: string[] = [];
  for (const root of roots) candidates.push(join(root, "db"));
  for (const root of roots) {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    if (home !== "") candidates.push(join(home, ".stm32cubemx", "databases"));
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (candidate.endsWith("databases")) {
      if (wantedVersion === "") continue;
      for (const name of readdirSync(candidate)) {
        if (name !== wantedVersion) continue;
        const version = readDbVersion(join(candidate, name, "db"));
        if (version !== null) return { root: join(candidate, name, "db"), version };
      }
      continue;
    }
    const version = readDbVersion(candidate);
    if (version === null) continue;
    if (wantedVersion !== "" && version !== wantedVersion) continue;
    return { root: candidate, version };
  }
  return null;
}

/** 解析一份 MCU XML（结构简单，用正则足够，零依赖）。 */
export function parseMcuXml(text: string): CubemxMcuFacts | null {
  const mcu = /<Mcu\b([^>]*)>/u.exec(text);
  if (mcu === null) return null;
  const attrs = mcu[1] as string;
  const name = /RefName="([^"]+)"/u.exec(attrs)?.[1] ?? "";
  const packageName = /Package="([^"]+)"/u.exec(attrs)?.[1] ?? "";
  const frequency = Number.parseInt(/<Frequency>(\d+)<\/Frequency>/u.exec(text)?.[1] ?? "", 10);

  // 族/产品线/内核/容量：db 3.0 之后才有，老 db 可能缺；缺就是空串/0，不猜。
  const family = /Family="([^"]+)"/u.exec(attrs)?.[1] ?? "";
  const line = /Line="([^"]+)"/u.exec(attrs)?.[1] ?? "";
  const core = /<Core>([^<]+)<\/Core>/u.exec(text)?.[1]?.trim() ?? "";
  const ramKb = Number.parseInt(/<Ram>(\d+)<\/Ram>/u.exec(text)?.[1] ?? "", 10);
  const ioNb = Number.parseInt(/<IONb>(\d+)<\/IONb>/u.exec(text)?.[1] ?? "", 10);
  const clockTree = /(?:^|\s)ClockTree="([^"]+)"/u.exec(attrs)?.[1] ?? "";
  const flashKb: number[] = [];
  for (const flash of text.matchAll(/<Flash>(\d+)<\/Flash>/gu)) {
    const size = Number.parseInt(flash[1] ?? "", 10);
    if (Number.isFinite(size) && !flashKb.includes(size)) flashKb.push(size);
  }

  const pins = new Map<string, CubemxPinFact>();
  // 两种写法都要认：自闭合 <Pin ... />（如 BOOT0）与带子节点的 <Pin ...> … </Pin>；
  // 属性顺序不固定（有的 Pin 把 Type 放前面），所以先抓整段属性再取字段。
  const pinBlocks = text.matchAll(/<Pin\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Pin>)/gu);
  for (const block of pinBlocks) {
    const pinAttrs = block[1] as string;
    const pinName = /(?:^|\s)Name="([^"]+)"/u.exec(pinAttrs)?.[1] ?? "";
    const pinPosition = Number.parseInt(/(?:^|\s)Position="(\d+)"/u.exec(pinAttrs)?.[1] ?? "", 10);
    if (pinName === "") continue;
    const signals = new Map<string, string[]>();
    for (const signal of (block[2] ?? "").matchAll(/<Signal\b([^>]*)\/?>/gu)) {
      const signalAttrs = signal[1] as string;
      const signalName = /Name="([^"]+)"/u.exec(signalAttrs)?.[1] ?? "";
      if (signalName === "") continue;
      const ioModes = /IOModes="([^"]+)"/u.exec(signalAttrs)?.[1] ?? "";
      signals.set(signalName, ioModes === "" ? [] : ioModes.split(",").map((item) => item.trim()));
    }
    pins.set(pinName, {
      name: pinName,
      position: Number.isFinite(pinPosition) ? pinPosition : 0,
      signals,
    });
  }

  const ips = new Map<string, CubemxIpFact>();
  // 两种写法都要认（U5 实测）：自闭合 <IP …/>（F1/F2/F4 这些单上下文族）与带子节点的
  // <IP …>…</IP>（TrustZone/多上下文族：<IP> 里挂 <ContextSplit>/<ContextIP>）。
  // 早先只认自闭合，U5 的 110 个 <IP> 里只有 1 个是自闭合的 —— RCC 正好不是，
  // 于是 readMcuFacts 读出来的 ips 里没有 RCC，时钟事实整族读不到（假结论「db 没有这一族的 RCC」）。
  // 键统一大写：.ioc 的 Mcu.IP<i> 与信号名都是大写实例名，而 ipModesPath/hasIpInstance 也按大写查。
  for (const ip of text.matchAll(/<IP\b([^>]*?)(?:\/>|>)/gu)) {
    const ipAttrs = ip[1] as string;
    const rawName = /InstanceName="([^"]+)"/u.exec(ipAttrs)?.[1] ?? "";
    if (rawName === "") continue;
    const instanceName = rawName.toUpperCase();
    ips.set(instanceName, {
      instanceName,
      name: /(?:^|\s)Name="([^"]+)"/u.exec(ipAttrs)?.[1] ?? "",
      version: /Version="([^"]+)"/u.exec(ipAttrs)?.[1] ?? "",
      configFile: /ConfigFile="([^"]+)"/u.exec(ipAttrs)?.[1] ?? "",
    });
  }

  if (pins.size === 0) return null;
  return {
    name,
    packageName,
    frequencyMhz: Number.isFinite(frequency) ? frequency : 0,
    family,
    line,
    core,
    ramKb: Number.isFinite(ramKb) ? ramKb : 0,
    flashKb,
    ioNb: Number.isFinite(ioNb) ? ioNb : 0,
    clockTree,
    pins,
    ips,
  };
}

/** 读某个芯片的 MCU XML。mcuName 就是 .ioc 里的 Mcu.Name，例如 STM32F103C(8-B)Tx。 */
export function readMcuFacts(db: CubemxDb, mcuName: string): CubemxMcuFacts | null {
  const file = join(db.root, "mcu", mcuName + ".xml");
  if (!existsSync(file)) return null;
  return parseMcuXml(readFileSync(file, "utf8"));
}

/**
 * 逻辑引脚名 → db 引脚名：先精确匹配，再按「去掉后缀」匹配。
 *
 * db 里同一根脚的写法逐族不同（实测）：
 *   F1/F0:  `PA0-WKUP`、`PC13-TAMPER-RTC`（连字符后缀）
 *   F7/L4:  `PA13 (JTMS-SWDIO)`（空格 + 括号里的复用功能）
 * 两种都要能对上，否则写进 .ioc 的键名 CubeMX 不认、整根脚被静默丢掉（L4 实测丢过 PA13/PA14）。
 */
export function resolveDbPinName(facts: CubemxMcuFacts, logical: string): string | null {
  if (facts.pins.has(logical)) return logical;
  const wanted = logical.trim().toUpperCase();
  for (const name of facts.pins.keys()) {
    if (pinBaseOf(name) === wanted) return name;
  }
  return null;
}

/**
 * db 引脚名去掉后缀（`PA0-WKUP` → PA0；`PA13 (JTMS-SWDIO)` → PA13；`PA13(JTMS/SWDIO)` → PA13）。
 *
 * 三种写法都在 db 里出现过（实测）：F1 用连字符、F7/L4 用「空格 + 括号」、H5 用「无空格 + 斜杠」。
 * 少拆一种，那根脚就解析不出来 → .ioc 里写的是逻辑名、CubeMX 不认、整根脚被静默丢掉（H5 实测丢过 SWD）。
 */
export function pinBaseOf(dbName: string): string {
  const trimmed = dbName.trim();
  const byParen = (trimmed.split("(")[0] ?? trimmed).trim();
  const bySpace = byParen.split(/\s+/u)[0] ?? byParen;
  return bySpace.split("-")[0] ?? bySpace;
}

/** 反查：db 引脚名 → 逻辑名（PA0-WKUP → PA0、PA13 (JTMS-SWDIO) → PA13）。 */
export function logicalPinName(dbName: string): string {
  return pinBaseOf(dbName);
}

/** 该芯片是否有这个 IP 实例（TIM3、ADC1…）。 */
export function hasIpInstance(facts: CubemxMcuFacts, instanceName: string): boolean {
  return facts.ips.has(instanceName.trim().toUpperCase());
}

/** 某个 IP 实例的 Modes 文件路径（db/mcu/IP/<Name>-<Version>_Modes.xml）。 */
export function ipModesPath(db: CubemxDb, facts: CubemxMcuFacts, instanceName: string): string | null {
  const ip = facts.ips.get(instanceName.trim().toUpperCase());
  if (ip === undefined) return null;
  const file = join(db.root, "mcu", "IP", ip.name + "-" + ip.version + "_Modes.xml");
  return existsSync(file) ? file : null;
}

/** 读某个 IP 的合法模式名（RefMode Name=…），例如 PWM Generation1 CH1。 */
export function readIpModeNames(db: CubemxDb, facts: CubemxMcuFacts, instanceName: string): string[] {
  const file = ipModesPath(db, facts, instanceName);
  if (file === null) return [];
  const text = readFileSync(file, "utf8");
  const names: string[] = [];
  for (const match of text.matchAll(/<RefMode\b[^>]*Name="([^"]+)"/gu)) names.push(match[1] as string);
  return [...new Set(names)];
}

/**
 * 读某个 IP 实例的合法参数名（Modes 文件里的 <RefParameter Name="…">），例如 USART1 的
 * BaudRate / WordLength / Parity。.ioc 里 `<IP>.<参数>` 的键名必须逐字等于这些名字，
 * 拼错就会被 CubeMX 静默丢弃——所以覆盖率闸门用它校验「形状对、名字错」。
 *
 * F1 系列有个坑：参数名不在 `db/mcu/<Mcu>.xml`（那里只有 <IP> 的实例清单，RefParameter 为 0），
 * 而在 `db/mcu/IP/<Name>-<Version>_Modes.xml` 里，所以要按 ipModesPath 再走一次。
 * 返回空数组表示「查不到，别据此判错」（调用方据此跳过校验）。
 */
const IP_PARAM_CACHE = new Map<string, readonly string[]>();

export function readIpParameterNames(db: CubemxDb, facts: CubemxMcuFacts, instanceName: string): string[] {
  const file = ipModesPath(db, facts, instanceName);
  if (file === null) return [];
  const cached = IP_PARAM_CACHE.get(file);
  if (cached !== undefined) return [...cached];
  const text = readFileSync(file, "utf8");
  const names: string[] = [];
  for (const match of text.matchAll(/<RefParameter\b[^>]*\bName="([^"]+)"/gu)) names.push(match[1] as string);
  const unique = [...new Set(names)];
  IP_PARAM_CACHE.set(file, unique);
  return [...unique];
}

/**
 * 这颗芯片上「真的有引脚」的外设族（USART / TIM / ADC / SPI …）。
 *
 * 用途：.ioc 的 Mcu.IPn 里除了真外设，还会出现内核项（CORTEX_M0+）、板名（NUCLEO-C031C6）、
 * SYS / DEBUG 这类没有引脚的东西。判断「进了 Mcu.IPn 却没有脚指向它 → CubeMX 会忽略」时，
 * 必须先排除它们——它们本来就不该有脚。db 的 <Pin><Signal Name=…> 是权威来源：
 * 芯片真实的引脚复用里出现过哪些外设族，就只校验这些族。
 *
 * 实测（2026-11，DB.6.0.150）：C0 的 STM32C031C(4-6)Tx.xml 的引脚信号里没有 CORTEX_M0+、
 * 也没有板名，而 USART2_TX / TIM3_CH1 / ADC1_IN13 都在 → 用它做判据不会误报内核项。
 */
export function instancesWithPins(facts: CubemxMcuFacts): Set<string> {
  const out = new Set<string>();
  for (const pin of facts.pins.values()) {
    for (const signal of pin.signals.keys()) {
      const name = signal.startsWith("S_") ? signal.slice(2) : signal;
      const head = (name.split("_")[0] ?? "").trim().toUpperCase();
      if (head === "") continue;
      // 同时收实例名（USART1）与族名（USART）：调用方拿 Mcu.IPn 里的实例名去比，
      // 而名字的粒度两边不一定一样（引脚信号里常带实例号：USART1_TX、TIM3_CH1）。
      out.add(head);
      const base = head.replace(/[0-9]+$/u, "");
      if (base !== "") out.add(base);
      // ADCx_IN1 / DACx_OUT1：共享信号的名字里没有实例号，只有族名 ADCx → 归到 ADC。
      if (/^ADCX?$/u.test(head)) out.add("ADC");
      if (/^DACX?$/u.test(head)) out.add("DAC");
    }
  }
  return out;
}

/** Mcu.IPn 里的实例名 → 族名（USART1 → USART、TIM3 → TIM；不接数字的原样大写）。 */
export function instanceFamilyName(instanceName: string): string {
  return instanceName.trim().toUpperCase().replace(/[0-9]+$/u, "");
}

