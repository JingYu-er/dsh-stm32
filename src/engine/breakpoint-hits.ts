/**
 * 断点命中记录：从 gdb 的输出里认出「停在哪」，攒成一份可回看的短历史。
 *
 * 只解析文本，不订阅 MI 事件——eval 的两条路径（常驻 MI / gdb -batch）都产出同一种
 * 停点描述，在这里统一处理，面板与命令行看到的是同一份记录。
 */

export interface BreakpointHit {
  /** gdb 的断点编号；从「已停下 —— …」这类没有编号的输出里认出的是 0。 */
  id: number;
  /** 停点描述，例如 `main () at src/main.c:67` 或观察点的旧值/新值。 */
  text: string;
  /** 记录时间（ISO 毫秒）。 */
  time: string;
}

/** 历史长度：一次联调最多回看这么多条停点。 */
export const HIT_LIMIT = 50;

const BREAKPOINT_LINE = /^Breakpoint (\d+), (.+)$/u;
const WATCHPOINT_LINE = /^(?:Hardware |Software |)watchpoint (\d+): (.+)$/u;
const STOPPED_LINE = /已停下 —— (.+)$/u;
const OLD_VALUE = /^Old value = (.+)$/u;
const NEW_VALUE = /^New value = (.+)$/u;

/** 从一段 gdb 输出里抽出停点；不认识的行走掉。 */
export function parseStops(output: string): Array<{ id: number; text: string }> {
  const stops: Array<{ id: number; text: string }> = [];
  const lines = output.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "") continue;
    const plain = BREAKPOINT_LINE.exec(line);
    if (plain !== null && plain[1] !== undefined && plain[2] !== undefined) {
      stops.push({ id: Number(plain[1]), text: plain[2].trim() });
      continue;
    }
    const watched = WATCHPOINT_LINE.exec(line);
    if (watched !== null && watched[1] !== undefined && watched[2] !== undefined) {
      // 观察点命中后紧跟两行旧值/新值，拼进同一条更有用。
      const parts = [watched[2].trim()];
      const old = OLD_VALUE.exec((lines[index + 1] ?? "").trim());
      const fresh = NEW_VALUE.exec((lines[index + 2] ?? "").trim());
      if (old !== null && old[1] !== undefined) parts.push("原值 " + old[1]);
      if (fresh !== null && fresh[1] !== undefined) parts.push("新值 " + fresh[1]);
      stops.push({ id: Number(watched[1]), text: parts.join("，") });
      continue;
    }
    const stopped = STOPPED_LINE.exec(line);
    if (stopped !== null && stopped[1] !== undefined) {
      const detail = stopped[1].replace(/（本次 eval 结束会按默认再 resume.*$/u, "").trim();
      if (detail !== "") stops.push({ id: 0, text: detail });
    }
  }
  return stops;
}

/** 环形历史：满了丢最旧的一条。 */
export class HitHistory {
  private readonly items: BreakpointHit[] = [];
  private readonly limit: number;

  constructor(limit: number = HIT_LIMIT) {
    this.limit = Math.max(1, Math.trunc(limit));
  }

  /** 把一段输出的停点追加进历史，返回本次新增条数。 */
  record(output: string, nowMs: number = Date.now()): number {
    const stops = parseStops(output);
    const time = new Date(nowMs).toISOString();
    for (const stop of stops) {
      this.items.push({ id: stop.id, text: stop.text, time: time });
      if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
    }
    return stops.length;
  }

  list(): BreakpointHit[] {
    return this.items.map((item) => ({ ...item }));
  }

  clear(): void {
    this.items.length = 0;
  }
}
