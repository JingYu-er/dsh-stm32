/**
 * L0：最小 zip 写入器（store，不压缩）—— 专门给 stm32_project_export 用。
 *
 * 为什么自己写而不用依赖：插件承诺零运行时依赖，为一个导出功能引 jszip/adm-zip 不值；
 * 固件工程以文本为主，store 体积可接受（源码包本来就不大）。CRC32 用查表法。
 */
import { createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

/** CRC32（IEEE 0xEDB88320，查表法）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    // Uint32Array 的索引读回 number | undefined（noUncheckedIndexedAccess）；下标恒在 0..255。
    const table = CRC_TABLE[(crc ^ byte) & 0xff];
    crc = ((table === undefined ? 0 : table) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 当前时间 → DOS 时间字段。 */
function dosTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

interface Entry {
  name: string;
  crc: number;
  bytes: number;
  offset: number;
}

/**
 * 写一个 store-only zip。sources: 条目名 → 磁盘路径；
 * 值以 `__inline__\n` 开头时表示内容就是那个字符串本身（README 用）。
 */
export async function makeZip(outPath: string, sources: Map<string, string>): Promise<void> {
  const chunks: Buffer[] = [];
  const entries: Entry[] = [];
  let offset = 0;
  const push = (buffer: Buffer): void => {
    chunks.push(buffer);
    offset += buffer.length;
  };
  const localHeader = (nameBuf: Buffer, crc: number, bytes: number, time: number, date: number): Buffer => {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes, 18);
    header.writeUInt32LE(bytes, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    return header;
  };

  const now = new Date();
  const { time, date } = dosTime(now);
  for (const [name, source] of sources) {
    const isInline = source.startsWith("__inline__\n");
    const data = isInline ? Buffer.from(source.slice("__inline__\n".length), "utf8") : readFileSync(source);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, "utf8");
    const header = localHeader(nameBuf, crc, data.length, time, date);
    entries.push({ name, crc, bytes: data.length, offset });
    push(header);
    push(nameBuf);
    push(data);
  }

  const centralStart = offset;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.bytes, 20);
    central.writeUInt32LE(entry.bytes, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(entry.offset, 42);
    push(central);
    push(nameBuf);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  push(end);

  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outPath);
    stream.on("error", reject);
    stream.on("finish", () => resolve());
    for (const chunk of chunks) stream.write(chunk);
    stream.end();
  });
}

/** 解包对账用（测试断言用；不带压缩支持，只认 store）。 */
export function listZipEntries(buffer: Buffer): string[] {
  const names: string[] = [];
  // 找 EOCD（从尾部扫描）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return names;
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) break;
    const nameLength = buffer.readUInt16LE(pointer + 28);
    names.push(buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength));
    const extra = buffer.readUInt16LE(pointer + 30);
    const comment = buffer.readUInt16LE(pointer + 32);
    pointer += 46 + nameLength + extra + comment;
  }
  return names;
}
