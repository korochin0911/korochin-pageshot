// Finalize the audio-only Opus WebM produced by Chromium MediaRecorder.
// Live WebM omits Duration. Add it without decoding/re-encoding the audio.
// https://www.matroska.org/technical/elements.html
// https://www.rfc-editor.org/rfc/rfc6716#section-3.1
const ID = { segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, cluster: 0x1f43b675,
  duration: 0x4489, scale: 0x2ad7b1, block: 0xa1, simpleBlock: 0xa3, blockGroup: 0xa0 };
const TOP_LEVEL = new Set([ID.info, ID.tracks, ID.cluster, 0x114d9b74, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469]);

function invalid() { throw new Error("WebM音声の再生時間を解析できませんでした。"); }

function vint(bytes, offset, end, isId = false) {
  if (offset >= end || !bytes[offset]) invalid();
  let width = 1, marker = 0x80;
  while (!(bytes[offset] & marker)) { marker >>= 1; width++; }
  if (width > (isId ? 4 : 8) || offset + width > end) invalid();
  let value = BigInt(isId ? bytes[offset] : bytes[offset] & (marker - 1));
  for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[offset + i]);
  const unknown = !isId && value === (1n << BigInt(width * 7)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return { width, value: unknown ? 0 : Number(value), unknown };
}

function element(bytes, start, end) {
  const id = vint(bytes, start, end, true), size = vint(bytes, start + id.width, end);
  const body = start + id.width + size.width;
  const finish = size.unknown ? end : body + size.value;
  if (finish > end) invalid();
  return { id: id.value, start, body, end: finish, size, sizeStart: start + id.width };
}

function children(bytes, parent) {
  const items = [];
  for (let cursor = parent.body; cursor < parent.end;) {
    const item = element(bytes, cursor, parent.end);
    if (item.size.unknown) invalid();
    items.push(item);
    cursor = item.end;
  }
  return items;
}

function uint(bytes, item) {
  if (!item || item.end - item.body > 8 || item.body === item.end) invalid();
  let value = 0;
  for (let i = item.body; i < item.end; i++) value = value * 256 + bytes[i];
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}

function float(bytes, item) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (item.end - item.body === 8) return view.getFloat64(item.body);
  if (item.end - item.body === 4) return view.getFloat32(item.body);
  invalid();
}

function sizeBytes(value, minimumWidth = 1) {
  let number = BigInt(value), width = minimumWidth;
  while (number >= (1n << BigInt(7 * width)) - 1n && width <= 8) width++;
  if (width > 8) invalid();
  const result = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) { result[i] = Number(number & 255n); number >>= 8n; }
  result[0] |= 1 << (8 - width);
  return result;
}

function opusDurationMs(bytes, start, end) {
  if (start >= end) invalid();
  const toc = bytes[start], config = toc >> 3, code = toc & 3;
  const frameMs = config >= 16 ? 2.5 * 2 ** (config & 3)
    : config >= 12 ? 10 * 2 ** (config & 1) : [10, 20, 40, 60][config & 3];
  if (code === 3 && start + 1 >= end) invalid();
  const frames = code === 0 ? 1 : code === 3 ? bytes[start + 1] & 63 : 2;
  const duration = frames * frameMs;
  if (!frames || duration > 120) invalid();
  return duration;
}

export async function finalizeWebmAudio(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let segment;
  for (let cursor = 0; cursor < bytes.length;) {
    const item = element(bytes, cursor, bytes.length);
    if (item.id === ID.segment) { segment = item; break; }
    if (item.size.unknown) invalid();
    cursor = item.end;
  }
  if (!segment) invalid();
  let info, duration, scale = 1000000, indexed = false, positioned = false, lastEndMs = 0, blockCount = 0;
  const tracks = new Map();

  function readBlock(item, clusterTime, paddingNs = 0, blockDuration) {
    const trackNumber = vint(bytes, item.body, item.end);
    const track = tracks.get(trackNumber.value), header = item.body + trackNumber.width;
    if (!track || header + 3 >= item.end || (bytes[header + 2] & 6)) invalid(); // No lacing in Chromium's output.
    const relativeTime = new DataView(bytes.buffer).getInt16(header);
    const packetMs = blockDuration === undefined ? opusDurationMs(bytes, header + 3, item.end) : blockDuration * scale / 1e6;
    lastEndMs = Math.max(lastEndMs, (clusterTime + relativeTime) * scale / 1e6 + packetMs - track.delayNs / 1e6 - paddingNs / 1e6);
    blockCount++;
  }

  function readCluster(cluster) {
    let cursor = cluster.body, timestamp = 0;
    while (cursor < cluster.end) {
      const item = element(bytes, cursor, cluster.end);
      // An unknown-sized Cluster ends at the next Segment-level element.
      if (cluster.size.unknown && TOP_LEVEL.has(item.id)) break;
      if (item.size.unknown) invalid();
      if (item.id === 0xe7) timestamp = uint(bytes, item);
      if (item.id === 0xa7 || item.id === 0xab) positioned = true;
      if (item.id === ID.simpleBlock) readBlock(item, timestamp);
      if (item.id === ID.blockGroup) {
        const group = children(bytes, item), block = group.find((child) => child.id === ID.block);
        const padding = group.find((child) => child.id === 0x75a2), length = group.find((child) => child.id === 0x9b);
        // Positive padding trims the end; negative padding trims the start.
        const paddingNs = padding && !(bytes[padding.body] & 0x80) ? uint(bytes, padding) : 0;
        if (block) readBlock(block, timestamp, paddingNs, length ? uint(bytes, length) : undefined);
      }
      cursor = item.end;
    }
    return cursor;
  }

  for (let cursor = segment.body; cursor < segment.end;) {
    const item = element(bytes, cursor, segment.end);
    if (item.id === ID.info) {
      if (info) invalid();
      info = item;
      const fields = children(bytes, info);
      const timestampScale = fields.find((child) => child.id === ID.scale);
      if (timestampScale) scale = uint(bytes, timestampScale);
      if (!(scale > 0)) invalid();
      duration = fields.find((child) => child.id === ID.duration);
      if (duration && Number.isFinite(float(bytes, duration)) && float(bytes, duration) > 0) return blob;
    } else if (item.id === ID.tracks) {
      for (const entry of children(bytes, item).filter((child) => child.id === 0xae)) {
        const fields = children(bytes, entry), get = (id) => fields.find((field) => field.id === id);
        const codec = get(0x86), delay = get(0x56aa), trackScale = get(0x23314f);
        if (uint(bytes, get(0x83)) !== 2 || !codec || new TextDecoder().decode(bytes.subarray(codec.body, codec.end)) !== "A_OPUS" ||
            (trackScale && float(bytes, trackScale) !== 1)) invalid();
        tracks.set(uint(bytes, get(0xd7)), { delayNs: delay ? uint(bytes, delay) : 0 });
      }
    } else if (item.id === ID.cluster) {
      if (!info) invalid();
      cursor = readCluster(item);
      continue;
    } else if (item.id === 0x114d9b74 || item.id === 0x1c53bb6b) indexed = true;
    if (item.size.unknown) invalid();
    cursor = item.end;
  }
  if (!info || !blockCount || !Number.isFinite(lastEndMs) || lastEndMs <= 0) invalid();
  const ticks = lastEndMs * 1e6 / scale;
  if (duration) {
    const result = bytes.slice(), view = new DataView(result.buffer);
    if (duration.end - duration.body === 8) view.setFloat64(duration.body, ticks);
    else view.setFloat32(duration.body, ticks);
    return new Blob([result], { type: blob.type });
  }
  // Inserting header bytes shifts media offsets. Live MediaRecorder files have
  // no indexes; refuse indexed inputs rather than leave stale seek positions.
  if (indexed || positioned) invalid();
  const added = new Uint8Array(11);
  added.set([0x44, 0x89, 0x88]);
  new DataView(added.buffer).setFloat64(3, ticks);
  const infoSize = sizeBytes(info.end - info.body + added.length, info.size.width);
  const delta = added.length + infoSize.length - info.size.width;
  const segmentSize = segment.size.unknown ? bytes.subarray(segment.sizeStart, segment.body)
    : sizeBytes(segment.end - segment.body + delta, segment.size.width);
  return new Blob([
    bytes.subarray(0, segment.sizeStart), segmentSize,
    bytes.subarray(segment.body, info.sizeStart), infoSize,
    bytes.subarray(info.body, info.end), added, bytes.subarray(info.end)
  ], { type: blob.type });
}
