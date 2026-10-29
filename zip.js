// Minimal ZIP (STORE). Images are already compressed; no third-party dependency is needed.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export async function makeZip(entries) {
  if (entries.length > 65535) throw new Error("ZIPのファイル数が多すぎます。");
  const locals = [], directories = [];
  let offset = 0, directorySize = 0;
  for (const entry of entries) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(entry.name) || entry.name.startsWith("/") || entry.name.split("/").includes("..")) {
      throw new Error("ZIPのファイル名が正しくありません。");
    }
    const name = encoder.encode(entry.name);
    const blob = entry.blob instanceof Blob ? entry.blob : new Blob([entry.blob]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(bytes);
    if (offset + bytes.length + name.length + 30 > 0xffffffff) throw new Error("ZIPが大きすぎます。");
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, 0x800, true); // UTF-8 names
    l.setUint16(12, 0x21, true); // 1980-01-01; capture times live in manifest.json
    l.setUint32(14, crc, true);
    l.setUint32(18, bytes.length, true);
    l.setUint32(22, bytes.length, true);
    l.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, blob);

    const directory = new Uint8Array(46 + name.length);
    const d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x800, true);
    d.setUint16(14, 0x21, true);
    d.setUint32(16, crc, true);
    d.setUint32(20, bytes.length, true);
    d.setUint32(24, bytes.length, true);
    d.setUint16(28, name.length, true);
    d.setUint32(42, offset, true);
    directory.set(name, 46);
    directories.push(directory);
    directorySize += directory.length;
    offset += local.length + bytes.length;
  }
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  return new Blob([...locals, ...directories, end], { type: "application/zip" });
}
