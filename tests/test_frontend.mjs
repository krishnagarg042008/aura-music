import test from "node:test";
import assert from "node:assert/strict";
import { buildShuffledQueue, isLocalOrLanHostname, parseClientLrc } from "../frontend/js/lrc-utils.js";

test("parseClientLrc parses standard LRC and skips metadata headers", () => {
  const raw = [
    "[00:00.00] 作词 : Writer",
    "[00:01.00] Producer: Studio",
    "[00:05.50] Neon lights across the sky",
    "[00:10.00] Floating in the night",
  ].join("\n");

  const parsed = parseClientLrc(raw, 180);
  assert.equal(parsed.synced, true);
  assert.equal(parsed.word_native, false);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].text, "Neon lights across the sky");
  assert.equal(parsed.lines[0].start, 5.5);
  assert.ok(parsed.lines[0].words.length > 0);
});

test("parseClientLrc detects enhanced word timestamps", () => {
  const raw = "[00:04.00] <00:04.10>Aura <00:04.50>spatial <00:05.10>sound";
  const parsed = parseClientLrc(raw, 120);
  assert.equal(parsed.synced, true);
  assert.equal(parsed.word_native, true);
  assert.equal(parsed.lines[0].words.length, 3);
  assert.equal(parsed.lines[0].words[1].start, 4.5);
});

test("parseClientLrc falls back cleanly to plain lyrics", () => {
  const raw = "[Chorus]\nFirst line\nSecond line";
  const parsed = parseClientLrc(raw, 120);
  assert.equal(parsed.synced, false);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].start, -1);
});

test("isLocalOrLanHostname detects localhost and private LAN IPs", () => {
  assert.equal(isLocalOrLanHostname("localhost"), true);
  assert.equal(isLocalOrLanHostname("127.0.0.1"), true);
  assert.equal(isLocalOrLanHostname("[::1]"), true);
  assert.equal(isLocalOrLanHostname("macbook.local"), true);
  assert.equal(isLocalOrLanHostname("192.168.1.42"), true);
  assert.equal(isLocalOrLanHostname("10.12.43.56"), true);
  assert.equal(isLocalOrLanHostname("172.16.0.10"), true);
  assert.equal(isLocalOrLanHostname("172.31.255.1"), true);

  assert.equal(isLocalOrLanHostname("172.32.0.1"), false);
  assert.equal(isLocalOrLanHostname("aura-music.onrender.com"), false);
  assert.equal(isLocalOrLanHostname("aura-music.vercel.app"), false);
});

test("buildShuffledQueue keeps current track first and preserves all tracks", () => {
  const tracks = [
    { videoId: "a" },
    { videoId: "b" },
    { videoId: "c" },
    { videoId: "d" },
  ];
  const { queue, currentIndex } = buildShuffledQueue(tracks, 2, () => 0.1);
  assert.equal(currentIndex, 0);
  assert.equal(queue[0].videoId, "c");
  assert.deepEqual(
    queue.map((t) => t.videoId).sort(),
    ["a", "b", "c", "d"]
  );
});
