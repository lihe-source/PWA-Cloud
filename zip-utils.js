const ZIP32_MAX = 0xffffffff;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let k = 0; k < 8; k += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(input) {
  const date = input instanceof Date && !Number.isNaN(input.getTime()) ? input : new Date();
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    time: ((hours & 0x1f) << 11) | ((minutes & 0x3f) << 5) | (seconds & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | ((month & 0x0f) << 5) | (day & 0x1f),
  };
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function normalizeName(value) {
  const clean = String(value || "file")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (clean || "file").slice(0, 220);
}

function splitExtension(filename) {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return [filename, ""];
  return [filename.slice(0, dot), filename.slice(dot)];
}

export class ZipStoreBuilder {
  constructor() {
    this.parts = [];
    this.centralEntries = [];
    this.offset = 0;
    this.names = new Set();
    this.count = 0;
  }

  uniqueName(value) {
    const normalized = normalizeName(value);
    const lowered = normalized.toLocaleLowerCase("zh-Hant");
    if (!this.names.has(lowered)) {
      this.names.add(lowered);
      return normalized;
    }
    const [base, extension] = splitExtension(normalized);
    let index = 2;
    while (index < 10000) {
      const candidate = `${base} (${index})${extension}`;
      const key = candidate.toLocaleLowerCase("zh-Hant");
      if (!this.names.has(key)) {
        this.names.add(key);
        return candidate;
      }
      index += 1;
    }
    throw new Error(`檔名重複過多：${normalized}`);
  }

  async add(name, blob, modifiedAt = new Date()) {
    if (!(blob instanceof Blob) || blob.size < 0) throw new Error("ZIP 項目內容無效");
    if (blob.size > ZIP32_MAX) throw new Error("單一檔案超過 ZIP32 的 4 GB 限制");
    if (this.count >= 65535) throw new Error("ZIP 項目數量超過 65,535 個限制");

    const filename = this.uniqueName(name);
    const filenameBytes = new TextEncoder().encode(filename);
    if (filenameBytes.length > 65535) throw new Error(`檔名過長：${filename}`);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const checksum = crc32(bytes);
    const size = blob.size;
    const timestamp = dosDateTime(modifiedAt);
    const localOffset = this.offset;

    const localHeader = new Uint8Array(30 + filenameBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, UTF8_FLAG);
    writeUint16(localView, 8, STORE_METHOD);
    writeUint16(localView, 10, timestamp.time);
    writeUint16(localView, 12, timestamp.date);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, size);
    writeUint32(localView, 22, size);
    writeUint16(localView, 26, filenameBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(filenameBytes, 30);

    this.parts.push(localHeader, blob);
    this.offset += localHeader.byteLength + size;
    if (this.offset > ZIP32_MAX) throw new Error("ZIP 總大小超過 ZIP32 的 4 GB 限制");

    const centralHeader = new Uint8Array(46 + filenameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, UTF8_FLAG);
    writeUint16(centralView, 10, STORE_METHOD);
    writeUint16(centralView, 12, timestamp.time);
    writeUint16(centralView, 14, timestamp.date);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, size);
    writeUint32(centralView, 24, size);
    writeUint16(centralView, 28, filenameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, localOffset);
    centralHeader.set(filenameBytes, 46);
    this.centralEntries.push(centralHeader);
    this.count += 1;
    return filename;
  }

  finalize() {
    if (!this.count) throw new Error("沒有可封裝的檔案");
    const centralOffset = this.offset;
    const centralSize = this.centralEntries.reduce((total, entry) => total + entry.byteLength, 0);
    if (centralOffset + centralSize > ZIP32_MAX) throw new Error("ZIP 總大小超過 ZIP32 的 4 GB 限制");

    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    writeUint32(view, 0, 0x06054b50);
    writeUint16(view, 4, 0);
    writeUint16(view, 6, 0);
    writeUint16(view, 8, this.count);
    writeUint16(view, 10, this.count);
    writeUint32(view, 12, centralSize);
    writeUint32(view, 16, centralOffset);
    writeUint16(view, 20, 0);

    return new Blob([...this.parts, ...this.centralEntries, end], { type: "application/zip" });
  }
}
