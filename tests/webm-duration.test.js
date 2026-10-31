import test from "node:test";
import assert from "node:assert/strict";
import { finalizeWebmAudio } from "../webm-duration.js";
import { webmFixture, cluster, simpleBlock, element, join, unsigned, hex } from "../test-support/webm-fixture.js";

function durationTicks(bytes) {
  // Independent byte-level inspection of the Duration element written to Info.
  const offset = Buffer.from(bytes).indexOf(Buffer.from([0x44, 0x89, 0x88]));
  assert.ok(offset >= 0, "Duration must exist as an eight-byte float");
  return new DataView(bytes.buffer, bytes.byteOffset).getFloat64(offset + 3);
}

async function finalize(options) {
  const fixture = webmFixture(options), original = new Blob([fixture.bytes], { type: "audio/webm;codecs=opus" });
  const blob = await finalizeWebmAudio(original);
  return { fixture, original, blob, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

test("a 31-second live recording gains finite duration including its final Opus packet", async () => {
  const { fixture, blob, bytes } = await finalize();
  assert.equal(durationTicks(bytes), 31000);
  assert.equal(blob.type, "audio/webm;codecs=opus");
  assert.deepEqual(bytes.slice(-fixture.clusters.length), fixture.clusters, "all encoded audio bytes remain unchanged");
  assert.equal(blob.size, fixture.bytes.length + 11);
  assert.equal(await finalizeWebmAudio(blob), blob, "finalizing twice is a no-op");
});

test("timestamp scale and signed block offsets determine duration instead of elapsed wall time", async () => {
  const { bytes } = await finalize({ scale: 100000, clusters: [cluster(10000, [simpleBlock(-100)])] });
  assert.equal(durationTicks(bytes), 10500); // 990 ms timestamp + 60 ms packet, in 0.1 ms ticks.
});

test("finite Segment and Info sizes remain valid when metadata headers grow", async () => {
  const { fixture, bytes } = await finalize({ finite: true, padding: 100 });
  assert.equal(durationTicks(bytes), 31000);
  assert.deepEqual(bytes.slice(-fixture.clusters.length), fixture.clusters);
  assert.ok(bytes.length > fixture.bytes.length + 11, "Info size should grow to a wider VINT");
  const result = await finalizeWebmAudio(new Blob([bytes]));
  assert.equal(result.size, bytes.length, "the rewritten parent sizes must be parseable");
});

test("known-sized clusters, multiple blocks, codec delay and trailing padding are accounted for", async () => {
  const block = element("a1", join(hex("81000080"), hex("f8fffe"))); // 20 ms Opus packet.
  const group = element("a0", join(block, element("75a2", join([0], unsigned(10000000)))));
  const { bytes } = await finalize({ delayNs: 6500000, clusters: [cluster(1000, [simpleBlock(-20), group], false)] });
  assert.equal(durationTicks(bytes), 1033.5); // First 60 ms packet ends at 1040 ms, minus codec delay.
  const trimmed = await finalize({ delayNs: 6500000, clusters: [cluster(1000, [group], false)] });
  assert.equal(durationTicks(trimmed.bytes), 1003.5);
});

test("already finalized duration is preserved; a zero or infinite duration is repaired", async () => {
  const finalized = await finalize({ duration: 1234 });
  assert.equal(finalized.blob, finalized.original);
  for (const duration of [0, Infinity, NaN]) {
    const repaired = await finalize({ duration });
    assert.equal(durationTicks(repaired.bytes), 31000);
    assert.equal(repaired.bytes.length, repaired.fixture.bytes.length);
  }
});

test("invalid or unsupported input fails safely instead of corrupting audio or indexes", async () => {
  const valid = webmFixture().bytes;
  for (const bytes of [new Uint8Array(), hex("000000"), valid.slice(0, 55), valid.slice(0, -1),
    webmFixture({ clusters: [] }).bytes,
    webmFixture({ extra: element("114d9b74", new Uint8Array()) }).bytes,
    webmFixture({ clusters: [cluster(0, [simpleBlock(0, hex("ff"))])] }).bytes,
    webmFixture({ clusters: [cluster(0, [simpleBlock(0, hex("f8fffe"), 0x82)])] }).bytes]) {
    await assert.rejects(finalizeWebmAudio(new Blob([bytes])), /再生時間/);
  }
});
