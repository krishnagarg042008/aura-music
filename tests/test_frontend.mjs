import test from "node:test";
import assert from "node:assert/strict";
import {
  buildShuffledQueue,
  detectExternalMusicUrl,
  isLocalOrLanHostname,
  parseClientLrc,
} from "../frontend/js/lrc-utils.js";
import {
  detectIndicScript,
  hasIndicScript,
  transliterateLine,
  transliterateWords,
} from "../frontend/js/transliterate.js";

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

test("detectIndicScript identifies Devanagari, Gurmukhi, and mixed lyrics", () => {
  assert.deepEqual(detectIndicScript(["मुझको इतना बताए कोई"]), {
    hasDevanagari: true,
    hasGurmukhi: false,
    hasIndic: true,
    label: "Hindi",
  });
  assert.deepEqual(detectIndicScript(["ਦੱਸ ਪੁੱਤ, ਤੇਰਾ head down ਕਾਸਤੋਂ?"]), {
    hasDevanagari: false,
    hasGurmukhi: true,
    hasIndic: true,
    label: "Punjabi",
  });
  assert.deepEqual(detectIndicScript(["ਤੇਰੀ-ਮੇਰੀ ਗੱਲਾਂ", "कर ना कभी तू"]), {
    hasDevanagari: true,
    hasGurmukhi: true,
    hasIndic: true,
    label: "Hindi & Punjabi",
  });
  assert.equal(hasIndicScript("Midnight neon sky"), false);
});

test("transliterateLine converts Hindi Devanagari and Punjabi Gurmukhi into clean Hinglish", () => {
  assert.equal(transliterateLine("मुझको इतना बताए कोई"), "Mujhko itna bataaye koi");
  assert.equal(transliterateLine("केसरिया तेरा इश्क़ है, पिया"), "Kesariya tera ishq hai, piya");
  assert.equal(transliterateLine("अच्छा धड़कन ज़िंदगी हमसफ़र अजनबी मतलब"), "Achchha dhadkan zindagi hamsafar ajnabi matlab");
  assert.equal(transliterateLine("ਦੱਸ ਪੁੱਤ, ਤੇਰਾ head down ਕਾਸਤੋਂ?"), "Dass putt, tera head down kaaston?");
  assert.equal(transliterateLine("ਕਿੱਥੇ ਚੱਲੀਏ? ਤੂੰ ਕਿੱਥੇ ਚੱਲੀਏ?"), "Kitthe challiye? Tu kitthe challiye?");
  assert.equal(transliterateLine("ਤੇਰੀ-ਮੇਰੀ ਗੱਲਾਂ ਹੋ ਗਈ ਮਸ਼ਹੂਰ"), "Teri-meri gallan ho gayi mashhoor");
});

test("transliterateWords preserves 1:1 timestamps for karaoke sync", () => {
  const input = [
    { text: "मुझको", start: 9.44, end: 11.2 },
    { text: "इतना", start: 11.2, end: 13.0 },
    { text: "बताए", start: 13.0, end: 15.1 },
    { text: "कोई?", start: 15.1, end: 17.5 },
  ];
  const out = transliterateWords(input);
  assert.deepEqual(
    out.map((w) => w.text),
    ["Mujhko", "itna", "bataaye", "koi?"]
  );
  assert.equal(out[1].start, 11.2);
  assert.equal(out[3].end, 17.5);
});

test("detectExternalMusicUrl recognizes Spotify, Apple Music, and YouTube playlist URLs", () => {
  assert.equal(detectExternalMusicUrl("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"), "spotify");
  assert.equal(detectExternalMusicUrl("open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"), "spotify");
  assert.equal(detectExternalMusicUrl("https://open.spotify.com/intl-en/playlist/37i9dQZF1DXcBWIGoYBM5M"), "spotify");
  assert.equal(detectExternalMusicUrl("Spotify:album:4yP0hdKOZPNshxUOjY0cZj"), "spotify");
  assert.equal(detectExternalMusicUrl("https://spotify.link/abc123"), "spotify");

  assert.equal(detectExternalMusicUrl("https://music.apple.com/in/album/after-hours/1499378108?i=1499378117"), "apple");
  assert.equal(detectExternalMusicUrl("music.apple.com/us/playlist/todays-hits/pl.f4d106fed2"), "apple");
  assert.equal(detectExternalMusicUrl("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2"), "apple");

  assert.equal(detectExternalMusicUrl("https://music.youtube.com/playlist?list=PL123456"), "youtube");
  assert.equal(detectExternalMusicUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(detectExternalMusicUrl("Blinding Lights The Weeknd"), null);
});
