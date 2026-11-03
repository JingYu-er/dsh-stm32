/**
 * 派生频率键的「跟随改写」（RCC.<外设>Freq_Value 这类）。
 *
 * 背景：.ioc 里每个外设都有一份自己的时钟值（USART1Freq_Value、I2C1Freq_Value、MCO1PinFreq_Value…），
 * 它们由 CubeMX 的时钟树按“多路选择器 + 分频”算出来。插件只写自己算得出的那几组
 * （SYSCLK/HCLK/APB1/APB2/ADC/TIM），其余交给 CubeMX 保存时重算 → ioc_verify 里每次都会多出一批
 * “派生键被重算”的记录（不参与 benign 判定，但噪声大，也说明我们承认了“不知道”）。
 *
 * 这里补一条保守规则：**旧值等于某个时钟域、且该域的新旧都唯一** 的派生键，跟着那个域改写。
 * 依据是 CubeMX 自己的默认选择（2026-11 C0 板级往返实测：I2C1/I2S1/USART1/MCO1Pin/MCO2Pin 五个键
 * 从 12 MHz（旧 SYSCLK=APB）变成 48 MHz（新 SYSCLK=APB），与 SYSCLK/APB 同步）。
 * 判据保守是为了不制造假的 valueChanged：
 *   - 旧值对不上任何时钟域 → 不动（例如 WatchDogFreq_Value=32000 走 LSI，永远对不上）；
 *   - 对上多个域、而这些域的新值又不一样（真的分叉了：比如 SYSCLK 72M 但 APB1 36M）→ 不动；
 *   - 计划自己已经写过的键 → 不动（以规划器的公式为准）。
 */

/** 可作为“跟随目标”的时钟域键名（新值从 entries 里读；旧值用改写前的快照）。 */
const CLOCK_SLOTS: readonly string[] = [
  "SYSCLKFreq_VALUE",
  "HCLKFreq_Value",
  "AHBFreq_Value",
  "CortexFreq_Value",
  "FCLKCortexFreq_Value",
  "APB1Freq_Value",
  "APB1TimFreq_Value",
  "APB2Freq_Value",
  "APB2TimFreq_Value",
  "APBFreq_Value",
  "APBTimFreq_Value",
  "ADCFreqValue",
  "ADCFreq_Value",
];

/** RCC 下的派生频率名（SYSCLKFreq_VALUE 的 VALUE 是全大写，必须忽略大小写）。 */
export function isDerivedFrequencyKey(key: string): boolean {
  return key.startsWith("RCC.") && /(?:Freq_Value|FreqValue)$/iu.test(key.slice("RCC.".length));
}

/**
 * 这些派生名看着是"频率"，但**不是**跟着 SYSCLK/APB 走的那批，不能拿旧值当跟随依据：
 *   - MCO1PinFreq_Value：MCO 输出脚，源由 RCC.MCO1Source 选（默认 HSI 16 MHz），和 SYSCLK 无关；
 *   - VCOInputFreq_Value / VCOOutputFreq_Value：PLL 内部节点（= PLL 输入、×N 之后的频率）；
 *   - PLL* / PLLI2S* / PLLSAI* / PLL1*：PLL 各路输出；
 *   - HSE/HSI/LSE/LSI/MSI：振荡器本身的频率，是**输入**不是输出；
 *   - RTC/LSCO/WatchDog：32 kHz 域（LSI/LSE）或独立域。
 *
 * 真机证据（2026-11 G4 @170 MHz 回归）：不排除 MCO1PinFreq_Value 与 VCOInputFreq_Value 时，
 * 这两个键的旧值恰好等于旧 SYSCLK（模板里就是这么写的），被"跟着走"改成 170 MHz，
 * 而 CubeMX 回写是 16 MHz / 4 MHz → ioc_verify 报两条 valueChanged、benign 翻成 false。
 */
const NOT_FOLLOWED = /^(?:MCO|LSCO|RTC|WatchDog|VCO|PLL|HSE|HSI|LSE|LSI|MSI)/iu;

/** 可以按"旧值等于某个时钟域"跟随改写的派生名。 */
export function isFollowableDerivedName(name: string): boolean {
  if (!/(?:Freq_Value|FreqValue)$/iu.test(name)) return false;
  return !NOT_FOLLOWED.test(name);
}

/** 跟随改写的记录，用于报告与单测。 */
export interface DerivedFollowEntry {
  /** 完整键名，例如 RCC.USART1Freq_Value。 */
  key: string;
  /** 旧值（Hz）。 */
  from: number;
  /** 新值（Hz）。 */
  to: number;
  /** 跟着哪个时钟域走的（不带 RCC. 前缀），例如 APB1Freq_Value。 */
  follows: string;
}

/** 没跟着走的原因（只列“旧值对上了、但新值分叉”的键，值对不上任何域的静默跳过）。 */
export interface DerivedFollowSkip {
  key: string;
  from: number;
  reason: "ambiguous";
}

export interface DerivedFollowResult {
  written: DerivedFollowEntry[];
  skipped: DerivedFollowSkip[];
}

/**
 * 按“旧值等于某个时钟域”的规则改写派生频率键。
 *
 * 参数 entries 会被就地改写；before 是改写前的快照（在规划器写键之前拍的 new Map(entries)）；
 * written 是本次计划已经写过的键，这些不碰（以规划器的值为准）。
 */
export function followDerivedClocks(
  entries: Map<string, string>,
  before: ReadonlyMap<string, string>,
  written: ReadonlySet<string>,
): DerivedFollowResult {
  const result: DerivedFollowResult = { written: [], skipped: [] };
  const slots: Array<{ name: string; oldHz: number; newHz: number }> = [];
  for (const name of CLOCK_SLOTS) {
    const key = "RCC." + name;
    const oldText = before.get(key);
    const newText = entries.get(key);
    if (oldText === undefined || newText === undefined) continue;
    if (!/^\d+$/u.test(oldText.trim()) || !/^\d+$/u.test(newText.trim())) continue;
    slots.push({ name, oldHz: Number.parseInt(oldText.trim(), 10), newHz: Number.parseInt(newText.trim(), 10) });
  }
  if (slots.length === 0) return result;
  for (const [key, value] of entries) {
    if (!isDerivedFrequencyKey(key)) continue;
    if (!isFollowableDerivedName(key.slice("RCC.".length))) continue;
    if (written.has(key)) continue;
    if (!/^\d+$/u.test(value.trim())) continue;
    const oldHz = Number.parseInt(value.trim(), 10);
    const hits = slots.filter((slot) => slot.oldHz === oldHz);
    if (hits.length === 0) continue;
    const newHz = hits[0]?.newHz as number;
    if (!hits.every((slot) => slot.newHz === newHz)) {
      result.skipped.push({ key, from: oldHz, reason: "ambiguous" });
      continue;
    }
    if (newHz === oldHz) continue;
    entries.set(key, String(newHz));
    result.written.push({ key, from: oldHz, to: newHz, follows: hits[0]?.name as string });
  }
  return result;
}
