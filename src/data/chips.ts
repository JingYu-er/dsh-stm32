/**
 * L1：芯片型号 → 可用引脚表（数据驱动，加型号只改这里）。
 *
 * 目前只覆盖用户明确要求支持的 STM32F103C8T6（蓝丸板，LQFP48）。
 * 未知型号一律放行（返回 true）——校验是为了拦住手误，不是为了当数据源；
 * 将来加新芯片：在 CHIPS 里补一条即可，不用改逻辑。
 */

export interface ChipInfo {
  /** 型号（= .ioc 里的 Mcu.CPN）。 */
  cpn: string;
  /** LQFP 封装引脚名（不含虚拟引脚 VP_*）。 */
  pins: readonly string[];
  /** 数据手册上的 Flash 大小（字节），用于提示链接脚本是否匹配。 */
  flashBytes: number;
  ramBytes: number;
}

function port(prefix: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let index = from; index <= to; index += 1) out.push(prefix + String(index));
  return out;
}

const CHIPS: readonly ChipInfo[] = [
  {
    cpn: "STM32F103C8T6",
    // LQFP48：PA0-15、PB0-15、PC13-15、PD0-1（PD0/PD1 默认是 OSC_IN/OSC_OUT）。
    pins: [...port("PA", 0, 15), ...port("PB", 0, 15), "PC13", "PC14", "PC15", "PD0", "PD1"],
    flashBytes: 64 * 1024,
    ramBytes: 20 * 1024,
  },
];

export function findChip(cpn: string): ChipInfo | null {
  const wanted = cpn.trim().toUpperCase();
  return CHIPS.find((chip) => chip.cpn.toUpperCase() === wanted) ?? null;
}

/** 引脚名是否属于该型号；未知型号或虚拟引脚（VP_*）一律放行。 */
export function isKnownPin(cpn: string, pin: string): boolean {
  if (pin.startsWith("VP_")) return true;
  const chip = findChip(cpn);
  if (chip === null) return true;
  return chip.pins.includes(pin.toUpperCase());
}

export const KNOWN_CHIPS = CHIPS;
