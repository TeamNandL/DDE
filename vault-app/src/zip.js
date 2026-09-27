// Minimal ZIP writer — STORE method only, no compression, no deps.
// Enough for a dad's export bundle (a handful of JSON + text files). Every
// mainstream unzip tool opens it. Timestamps are fixed to the export's
// own `now` so two exports of identical content hash identically.

import { crc32 } from "node:zlib";

function dosDateTime(date) {
  const d = new Date(date);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const day = ((Math.max(d.getUTCFullYear(), 1980) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, day };
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/**
 * @param {Array<{ name: string, data: string | Buffer }>} entries
 * @param {{ now?: number | string | Date }} [opts]
 * @returns {Buffer}
 */
export function zipStore(entries, opts = {}) {
  const { time, day } = dosDateTime(opts.now ?? Date.now());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0),
      name, data,
    ]);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(time), u16(day),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), name,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, central, end]);
}

/** Read back a STORE zip (tests / operator sanity) → [{name, data}]. */
export function unzipStore(buf) {
  const out = [];
  let p = 0;
  while (p + 4 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
    const size = buf.readUInt32LE(p + 18);
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const name = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const start = p + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + size);
    if (crc32(data) !== buf.readUInt32LE(p + 14)) throw new Error(`zip: crc mismatch in ${name}`);
    out.push({ name, data });
    p = start + size;
  }
  return out;
}
