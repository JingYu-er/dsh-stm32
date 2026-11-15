const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function chunkType(buffer, offset) {
    return buffer.toString("latin1", offset, offset + 4);
}
export function decodePng(buffer) {
    if (buffer.length < 8 || SIGNATURE.some((byte, index) => buffer[index] !== byte)) {
        return { ok: false, error: "不是 PNG 文件" };
    }
    let offset = 8;
    let width = 0;
    let height = 0;
    let colorType = 0;
    let bitDepth = 0;
    let interlace = 0;
    const idat = [];
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = chunkType(buffer, offset + 4);
        const body = buffer.subarray(offset + 8, offset + 8 + length);
        if (type === "IHDR") {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            bitDepth = body[8] ?? 0;
            colorType = body[9] ?? 0;
            interlace = body[12] ?? 0;
        }
        else if (type === "IDAT") {
            idat.push(Buffer.from(body));
        }
        else if (type === "IEND") {
            break;
        }
        offset += 12 + length;
    }
    if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        return { ok: false, error: "只支持 8 位非隔行 RGB/RGBA PNG（实际 bitDepth " + bitDepth + " colorType " + colorType + "）" };
    }
    const inflate = inflateSync(Buffer.concat(idat));
    const channels = colorType === 6 ? 4 : 3;
    const stride = width * channels;
    const raw = new Uint8Array(height * stride);
    let source = 0;
    for (let y = 0; y < height; y += 1) {
        const filter = inflate[source] ?? 0;
        source += 1;
        const row = y * stride;
        for (let x = 0; x < stride; x += 1) {
            const value = inflate[source + x] ?? 0;
            const left = x >= channels ? (raw[row + x - channels] ?? 0) : 0;
            const up = y > 0 ? (raw[row - stride + x] ?? 0) : 0;
            const upLeft = y > 0 && x >= channels ? (raw[row - stride + x - channels] ?? 0) : 0;
            let reconstructed = value;
            if (filter === 1)
                reconstructed = value + left;
            else if (filter === 2)
                reconstructed = value + up;
            else if (filter === 3)
                reconstructed = value + ((left + up) >> 1);
            else if (filter === 4)
                reconstructed = value + paeth(left, up, upLeft);
            raw[row + x] = reconstructed & 0xff;
        }
        source += stride;
    }
    const rgba = new Uint8Array(width * height * 4);
    for (let index = 0; index < width * height; index += 1) {
        rgba[index * 4] = raw[index * channels] ?? 0;
        rgba[index * 4 + 1] = raw[index * channels + 1] ?? 0;
        rgba[index * 4 + 2] = raw[index * channels + 2] ?? 0;
        rgba[index * 4 + 3] = channels === 4 ? (raw[index * channels + 3] ?? 255) : 255;
    }
    return { ok: true, image: { width, height, rgba } };
}
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc)
        return a;
    return pb <= pc ? b : c;
}
import { inflateSync } from "node:zlib";
