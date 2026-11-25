/**
 * AURA Indic -> Hinglish / Roman Transliteration Engine.
 *
 * Auto-detects Devanagari (Hindi) and Gurmukhi (Punjabi) script in lyrics
 * and converts them to natural, readable Hinglish/Roman script token-for-token
 * so word-level karaoke timings remain 1:1 synchronized.
 */

const DEVA_CONSONANTS = {
  "\u0915": "k", "\u0916": "kh", "\u0917": "g", "\u0918": "gh", "\u0919": "ng",
  "\u091A": "ch", "\u091B": "chh", "\u091C": "j", "\u091D": "jh", "\u091E": "ny",
  "\u091F": "t", "\u0920": "th", "\u0921": "d", "\u0922": "dh", "\u0923": "n",
  "\u0924": "t", "\u0925": "th", "\u0926": "d", "\u0927": "dh", "\u0928": "n", "\u0929": "n",
  "\u092A": "p", "\u092B": "ph", "\u092C": "b", "\u092D": "bh", "\u092E": "m",
  "\u092F": "y", "\u0930": "r", "\u0931": "r", "\u0932": "l", "\u0933": "l", "\u0934": "l", "\u0935": "v",
  "\u0936": "sh", "\u0937": "sh", "\u0938": "s", "\u0939": "h",
  "\u0958": "q", "\u0959": "kh", "\u095A": "gh", "\u095B": "z",
  "\u095C": "d", "\u095D": "dh", "\u095E": "f", "\u095F": "y",
};

const DEVA_NUKTA_BASE = {
  "\u0915": "q", "\u0916": "kh", "\u0917": "gh", "\u091C": "z",
  "\u0921": "d", "\u0922": "dh", "\u092B": "f", "\u092F": "y",
  "\u0928": "n", "\u0932": "l", "\u0936": "sh", "\u0938": "sh",
};

const DEVA_INDEP_VOWELS = {
  "\u0905": "a", "\u0906": "aa", "\u0907": "i", "\u0908": "ee",
  "\u0909": "u", "\u090A": "oo", "\u090B": "ri", "\u090C": "li",
  "\u090D": "e", "\u090E": "e", "\u090F": "e", "\u0910": "ai",
  "\u0911": "o", "\u0912": "o", "\u0913": "o", "\u0914": "au",
  "\u0972": "a", "\u0973": "oe",
};

const DEVA_MATRAS = {
  "\u093E": "aa", "\u093F": "i", "\u0940": "ee", "\u0941": "u", "\u0942": "oo",
  "\u0943": "ri", "\u0944": "ree", "\u0945": "e", "\u0946": "e", "\u0947": "e",
  "\u0948": "ai", "\u0949": "o", "\u094A": "o", "\u094B": "o", "\u094C": "au",
};

const GURU_CONSONANTS = {
  "\u0A15": "k", "\u0A16": "kh", "\u0A17": "g", "\u0A18": "gh", "\u0A19": "ng",
  "\u0A1A": "ch", "\u0A1B": "chh", "\u0A1C": "j", "\u0A1D": "jh", "\u0A1E": "ny",
  "\u0A1F": "t", "\u0A20": "th", "\u0A21": "d", "\u0A22": "dh", "\u0A23": "n",
  "\u0A24": "t", "\u0A25": "th", "\u0A26": "d", "\u0A27": "dh", "\u0A28": "n",
  "\u0A2A": "p", "\u0A2B": "ph", "\u0A2C": "b", "\u0A2D": "bh", "\u0A2E": "m",
  "\u0A2F": "y", "\u0A30": "r", "\u0A32": "l", "\u0A33": "l", "\u0A35": "v",
  "\u0A36": "sh", "\u0A38": "s", "\u0A39": "h",
  "\u0A59": "kh", "\u0A5A": "gh", "\u0A5B": "z", "\u0A5C": "d", "\u0A5E": "f",
};

const GURU_NUKTA_BASE = {
  "\u0A16": "kh", "\u0A17": "gh", "\u0A1C": "z", "\u0A2B": "f",
  "\u0A32": "l", "\u0A38": "sh",
};

const GURU_BEARERS = new Set(["\u0A72", "\u0A73", "\u0A05"]);

const GURU_INDEP_VOWELS = {
  "\u0A05": "a", "\u0A06": "aa", "\u0A07": "i", "\u0A08": "ee",
  "\u0A09": "u", "\u0A0A": "oo", "\u0A0F": "e", "\u0A10": "ai",
  "\u0A13": "o", "\u0A14": "au",
};

const GURU_MATRAS = {
  "\u0A3E": "aa", "\u0A3F": "i", "\u0A40": "ee", "\u0A41": "u", "\u0A42": "oo",
  "\u0A47": "e", "\u0A48": "ai", "\u0A4B": "o", "\u0A4C": "au",
};

const VIRAMA_SET = new Set(["\u094D", "\u0A4D"]);
const NUKTA_SET = new Set(["\u093C", "\u0A3C"]);
const NASAL_SET = new Set(["\u0901", "\u0902", "\u0A01", "\u0A02", "\u0A70"]);
const VISARGA_SET = new Set(["\u0903", "\u0A03"]);
const ADDAK = "\u0A71";

const INDIC_RE = /[\u0900-\u097F\u0A00-\u0A7F]/;
const DEVA_RE = /[\u0900-\u097F]/;
const GURU_RE = /[\u0A00-\u0A7F]/;

const SPECIAL_WORDS = {
  "मैं": "main", "में": "mein", "हैं": "hain", "है": "hai", "हूँ": "hoon", "हूं": "hoon",
  "तू": "tu", "तूँ": "tu", "तूने": "tune", "तुझे": "tujhe", "मुझे": "mujhe",
  "नहीं": "nahi", "नही": "nahi", "यूँ": "yun", "हाँ": "haan", "ना": "na",
  "ਮੈਂ": "main", "ਮੇਂ": "mein", "ਹੈਂ": "hain", "ਹੈ": "hai", "ਹੂੰ": "hoon",
  "ਤੂੰ": "tu", "ਤੂ": "tu", "ਨਹੀਂ": "nahi", "ਨਹੀ": "nahi", "ਐ": "ai", "ਆਂ": "aan", "ਹਾਂ": "haan",
};

function getConsonant(ch, hasNukta) {
  if (hasNukta) {
    if (DEVA_NUKTA_BASE[ch]) return DEVA_NUKTA_BASE[ch];
    if (GURU_NUKTA_BASE[ch]) return GURU_NUKTA_BASE[ch];
  }
  return DEVA_CONSONANTS[ch] || GURU_CONSONANTS[ch] || null;
}

export function hasIndicScript(text) {
  return INDIC_RE.test(String(text || ""));
}

export function detectIndicScript(linesOrText) {
  let sample = "";
  if (Array.isArray(linesOrText)) {
    sample = linesOrText.map((ln) => (typeof ln === "string" ? ln : ln?.text || "")).join("\n");
  } else {
    sample = String(linesOrText || "");
  }
  const hasDevanagari = DEVA_RE.test(sample);
  const hasGurmukhi = GURU_RE.test(sample);
  const hasIndic = hasDevanagari || hasGurmukhi;
  let label = "";
  if (hasDevanagari && hasGurmukhi) label = "Hindi & Punjabi";
  else if (hasDevanagari) label = "Hindi";
  else if (hasGurmukhi) label = "Punjabi";
  return { hasDevanagari, hasGurmukhi, hasIndic, label };
}

function transliterateIndicRun(word) {
  if (SPECIAL_WORDS[word]) return SPECIAL_WORDS[word];

  const chars = Array.from(word);
  const syllables = [];
  let i = 0;

  while (i < chars.length) {
    const ch = chars[i];

    // Independent vowel or Gurmukhi bearer (ੲ, ੳ, ਅ) + optional matra
    if (DEVA_INDEP_VOWELS[ch] || GURU_INDEP_VOWELS[ch] || GURU_BEARERS.has(ch)) {
      let vowel = DEVA_INDEP_VOWELS[ch] || GURU_INDEP_VOWELS[ch] || "";
      i++;
      if (i < chars.length && (DEVA_MATRAS[chars[i]] || GURU_MATRAS[chars[i]])) {
        vowel = DEVA_MATRAS[chars[i]] || GURU_MATRAS[chars[i]];
        i++;
      } else if (ch === "\u0A73" && !vowel) {
        vowel = "o";
      } else if (ch === "\u0A72" && !vowel) {
        vowel = "i";
      }
      let nasal = false;
      let visarga = false;
      let addak = false;
      while (i < chars.length && (NASAL_SET.has(chars[i]) || VISARGA_SET.has(chars[i]) || chars[i] === ADDAK)) {
        if (NASAL_SET.has(chars[i])) nasal = true;
        if (VISARGA_SET.has(chars[i])) visarga = true;
        if (chars[i] === ADDAK) addak = true;
        i++;
      }
      syllables.push({
        onsets: [], vowel: vowel || "a", rawMatra: null, isSchwa: false,
        isIndepVowel: true, nasal, visarga, addakAfter: addak,
      });
      continue;
    }

    const hasNukta = i + 1 < chars.length && NUKTA_SET.has(chars[i + 1]);
    if (getConsonant(ch, hasNukta)) {
      const onsets = [];
      let keepReadingOnset = true;

      while (keepReadingOnset && i < chars.length) {
        const cur = chars[i];
        const nextIsNukta = i + 1 < chars.length && NUKTA_SET.has(chars[i + 1]);
        const romC = getConsonant(cur, nextIsNukta);
        if (!romC) break;
        i += nextIsNukta ? 2 : 1;

        if (cur === "\u091C" && i + 1 < chars.length && VIRAMA_SET.has(chars[i]) && chars[i + 1] === "\u091E") {
          onsets.push("gy");
          i += 2;
        } else {
          onsets.push(romC);
        }

        if (i < chars.length && VIRAMA_SET.has(chars[i])) {
          i++;
          if (i < chars.length && getConsonant(chars[i], i + 1 < chars.length && NUKTA_SET.has(chars[i + 1]))) {
            keepReadingOnset = true;
          } else {
            syllables.push({
              onsets, vowel: "", rawMatra: "virama", isSchwa: false,
              isIndepVowel: false, nasal: false, visarga: false, addakAfter: false,
            });
            keepReadingOnset = false;
            onsets.length = 0;
          }
        } else {
          keepReadingOnset = false;
        }
      }

      if (onsets.length === 0) continue;

      let vowel = "a";
      let rawMatra = null;
      let isSchwa = true;
      if (i < chars.length && (DEVA_MATRAS[chars[i]] || GURU_MATRAS[chars[i]])) {
        rawMatra = chars[i];
        vowel = DEVA_MATRAS[rawMatra] || GURU_MATRAS[rawMatra];
        isSchwa = false;
        i++;
      }

      let nasal = false;
      let visarga = false;
      let addakAfter = false;
      while (i < chars.length && (NASAL_SET.has(chars[i]) || VISARGA_SET.has(chars[i]) || chars[i] === ADDAK)) {
        if (NASAL_SET.has(chars[i])) nasal = true;
        if (VISARGA_SET.has(chars[i])) visarga = true;
        if (chars[i] === ADDAK) addakAfter = true;
        i++;
      }

      syllables.push({
        onsets, vowel, rawMatra, isSchwa, isIndepVowel: false,
        nasal, visarga, addakAfter,
      });
      continue;
    }

    i++;
  }

  if (!syllables.length) return word;

  // Apply Gurmukhi Addak gemination to the following consonant onset
  for (let s = 1; s < syllables.length; s++) {
    if (syllables[s - 1].addakAfter && syllables[s].onsets.length > 0) {
      const firstOnset = syllables[s].onsets[0];
      syllables[s].onsets[0] = firstOnset[0] + firstOnset;
    }
  }

  // Step 1: Drop word-final inherent schwa (when word has > 1 syllable)
  const n = syllables.length;
  const last = syllables[n - 1];
  if (n > 1 && last.isSchwa && !last.nasal && !last.visarga) {
    const isFinalCy = last.onsets.length === 2 && last.onsets[1] === "y";
    if (!isFinalCy) {
      last.vowel = "";
      last.isSchwa = false;
    }
  }

  // Handle verb/inflection suffixes (-na/-ne/-ni/-ta/-te/-ti/-da/-de/-di/-ga/-ge/-gi) on 3+ syllable stems
  const VERB_SUFFIX_ONSETS = new Set(["n", "t", "d", "g", "v", "w"]);
  const hasSuffixBoundary = (
    n >= 4 &&
    last.onsets.length === 1 &&
    VERB_SUFFIX_ONSETS.has(last.onsets[0]) &&
    ["\u093E", "\u0947", "\u0940", "\u0A3E", "\u0A47", "\u0A40"].includes(last.rawMatra) &&
    syllables[n - 2].isSchwa &&
    !syllables[n - 2].nasal &&
    syllables[n - 2].onsets.length === 1
  );
  if (hasSuffixBoundary && syllables[n - 3].vowel && !syllables[n - 3].nasal) {
    syllables[n - 2].vowel = "";
    syllables[n - 2].isSchwa = false;
  }

  // Step 2: Medial schwa deletion in open VC_CV frames
  for (let s = 1; s < n - 1; s++) {
    const cur = syllables[s];
    const prev = syllables[s - 1];
    const next = syllables[s + 1];

    if (!cur.isSchwa) continue;
    if (cur.nasal || cur.visarga || cur.addakAfter) continue;
    if (cur.onsets.length > 1) continue;
    if (prev.nasal || prev.onsets.length > 1 || !prev.vowel) continue;
    if (!next.vowel) continue;
    if (
      next.onsets.length === 1 &&
      next.onsets[0] === "r" &&
      (next.rawMatra === "\u093F" || next.rawMatra === "\u0A3F") &&
      s + 2 < n &&
      syllables[s + 2].onsets[0] === "y"
    ) {
      continue;
    }
    cur.vowel = "";
    cur.isSchwa = false;
  }

  let out = "";
  for (let s = 0; s < n; s++) {
    const sym = syllables[s];
    const isFirst = s === 0;
    const isLast = s === n - 1;
    const prev = s > 0 ? syllables[s - 1] : null;
    const next = s + 1 < n ? syllables[s + 1] : null;

    let onsetStr = "";
    for (let o = 0; o < sym.onsets.length; o++) {
      let c = sym.onsets[o];
      if (c === "v") {
        const atWordEndCoda = isLast && !sym.vowel && o === sym.onsets.length - 1;
        const beforeFrontI = o === sym.onsets.length - 1 && (sym.vowel === "i" || sym.vowel === "ee");
        const isInitialV = isFirst && o === 0 && (sym.vowel === "i" || sym.vowel === "ee" || sym.vowel === "e");
        c = (atWordEndCoda || beforeFrontI || isInitialV) ? "v" : "w";
      }
      onsetStr += c;
    }

    let v = sym.vowel;
    if (sym.rawMatra === "\u093E" || sym.rawMatra === "\u0A3E") {
      if (isLast) v = "a";
    } else if (sym.rawMatra === "\u0940" || sym.rawMatra === "\u0A40") {
      if (isLast || (next && next.isIndepVowel)) v = "i";
    } else if (sym.rawMatra === "\u0942" || sym.rawMatra === "\u0A42") {
      if (isLast && sym.nasal) v = "u";
    } else if (sym.isIndepVowel && v === "ee" && isLast) {
      v = prev && prev.vowel === "a" && !prev.nasal ? "yi" : "i";
    } else if (
      sym.isIndepVowel &&
      v === "e" &&
      prev &&
      !prev.nasal &&
      ["\u0940", "\u0A40", "\u093F", "\u0A3F", "\u093E", "\u0A3E"].includes(prev.rawMatra)
    ) {
      v = "ye";
    } else if (sym.isIndepVowel && v === "oo" && prev && (prev.vowel === "aa" || prev.vowel === "a" || prev.vowel === "o")) {
      v = "u";
    }

    let nasalStr = "";
    if (sym.nasal) {
      const nextCons = next?.onsets[0] || "";
      nasalStr = /^(p|ph|b|bh|m)/.test(nextCons) ? "m" : "n";
    }

    out += onsetStr + v + nasalStr + (sym.visarga ? "h" : "");
  }

  return out;
}

export function transliterateWord(token, capitalizeFirst = false) {
  const raw = String(token || "");
  if (!INDIC_RE.test(raw)) return raw;
  let out = raw.replace(/[\u0900-\u097F\u0A00-\u0A7F]+/g, (run) => transliterateIndicRun(run));
  if (capitalizeFirst) {
    out = out.replace(/^([^a-zA-Z]*)([a-z])/, (_, pre, c) => pre + c.toUpperCase());
  }
  return out;
}

export function transliterateLine(line) {
  const str = String(line || "");
  if (!INDIC_RE.test(str)) return str;
  const tokens = str.split(/(\s+)/);
  let capitalizeNext = true;
  return tokens
    .map((tok) => {
      if (!tok.trim()) return tok;
      const hasIndic = INDIC_RE.test(tok);
      const conv = hasIndic ? transliterateWord(tok, capitalizeNext) : tok;
      if (hasIndic) capitalizeNext = false;
      if (/[.!?]$/.test(tok)) capitalizeNext = true;
      return conv;
    })
    .join("");
}

export function transliterateWords(words) {
  let capitalizeNext = true;
  return (words || []).map((w) => {
    const text = String(w?.text || "");
    const hasIndic = INDIC_RE.test(text);
    const roman = hasIndic ? transliterateWord(text, capitalizeNext) : text;
    if (hasIndic) capitalizeNext = false;
    if (/[.!?]$/.test(text)) capitalizeNext = true;
    return {
      text: roman,
      start: w.start,
      end: w.end,
    };
  });
}
