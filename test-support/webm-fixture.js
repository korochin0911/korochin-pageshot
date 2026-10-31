// Small audio-only WebM streams with genuine Opus silence packets.
export const join = (...parts) => new Uint8Array(parts.flatMap((part) => [...part]));
export const hex = (value) => Uint8Array.from(value.match(/../g).map((pair) => parseInt(pair, 16)));
export function size(value) {
  let width = 1;
  while (value >= 2 ** (width * 7) - 1) width++;
  const result = new Uint8Array(width);
  for (let i = width - 1, rest = value; i >= 0; i--, rest = Math.floor(rest / 256)) result[i] = rest & 255;
  result[0] |= 1 << (8 - width);
  return result;
}
export const element = (id, body) => join(hex(id), size(body.length), body);
export const unsigned = (value) => {
  let width = 1;
  while (value >= 2 ** (width * 8)) width++;
  const result = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--, value = Math.floor(value / 256)) result[i] = value & 255;
  return result;
};
export const float64 = (value) => { const result = new Uint8Array(8); new DataView(result.buffer).setFloat64(0, value); return result; };
export const opusSilence = hex("ff03fffefffefffe"); // Three 20 ms frames.
export const simpleBlock = (relative = 0, packet = opusSilence, flags = 0x80) => {
  const header = new Uint8Array([0x81, 0, 0, flags]);
  new DataView(header.buffer).setInt16(1, relative);
  return element("a3", join(header, packet));
};
export const cluster = (timestamp, blocks, unknown = true) => {
  const body = join(element("e7", unsigned(timestamp)), ...blocks);
  return unknown ? join(hex("1f43b67501ffffffffffffff"), body) : element("1f43b675", body);
};

export function webmFixture({ scale = 1000000, duration, padding = 0, finite = false, delayNs = 0,
  clusters = [cluster(0, [simpleBlock(0)]), cluster(30940, [simpleBlock(0)])], extra = new Uint8Array() } = {}) {
  const info = element("1549a966", join(element("2ad7b1", unsigned(scale)), element("4d80", new TextEncoder().encode("Chrome")),
    ...(duration === undefined ? [] : [element("4489", float64(duration))]),
    ...(padding ? [element("ec", new Uint8Array(padding))] : [])));
  const tracks = element("1654ae6b", element("ae", join(element("d7", unsigned(1)), element("83", unsigned(2)),
    element("86", new TextEncoder().encode("A_OPUS")),
    element("63a2", hex("4f707573486561640102000080bb0000000000")),
    element("56aa", unsigned(delayNs)),
    element("e1", join(element("b5", float64(48000)), element("9f", unsigned(2)))))));
  const body = join(info, tracks, extra, ...clusters);
  const header = hex("1a45dfa39f4286810142f7810142f2810442f381084282847765626d4287810442858102");
  const segment = finite ? element("18538067", body) : join(hex("1853806701ffffffffffffff"), body);
  return { bytes: join(header, segment), clusters: join(...clusters), header: join(header, segment.subarray(0, segment.length - body.length), info, tracks, extra) };
}
