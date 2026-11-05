/* Romanization of lyrics, line by line. Done here, with no model, where a script maps to Latin by rule: Hangul (Revised
   Romanization), kana (Hepburn) and Chinese (pinyin, from a dictionary, so a character reads by its word). What needs
   reading knowledge a rule cannot hold (kanji in Japanese, Cyrillic, Arabic, Thai, Hindi…) is left for the local model:
   `romanizeLocal` returns null for it and `needsModel` says why. Pure functions, no DOM. */

export type Script = "latin" | "hangul" | "kana" | "han" | "other";

const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
const KANA = /[ぁ-ゖァ-ヺー]/;
const HAN = /[㐀-䶿一-鿿]/;
const NON_LATIN = /[Ͱ-ϿЀ-ӿ֐-ۿऀ-෿฀-๿Ⴀ-ჿ]/;

/** The script a line is mostly in, for choosing how to romanize it. */
export function scriptOf(text: string): Script {
  if (HANGUL.test(text)) return "hangul";
  if (KANA.test(text)) return "kana";
  if (HAN.test(text)) return "han";
  return NON_LATIN.test(text) ? "other" : "latin";
}
/** Whether a language (Whisper's code) is written in a script worth romanizing. */
export const ROMANIZED = new Set(["ja", "ko", "zh", "yue", "ru", "uk", "bg", "sr", "el", "ar", "fa", "he", "hi", "th", "bn", "ta", "te", "ka", "hy"]);

// ---------- Hangul: Revised Romanization of Korea ----------
const INITIAL = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const VOWEL = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const FINAL = ["", "k", "kk", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];
/** A single final consonant that carries over to a vowel-initial syllable after it, as the index of the initial it becomes. */
const CARRY: Record<number, number> = { 1: 0, 2: 1, 4: 2, 7: 3, 8: 5, 16: 6, 17: 7, 19: 9, 20: 10, 22: 12, 23: 14, 24: 15, 25: 16, 26: 17, 27: 18 };

export function romanizeHangul(text: string): string {
  const out: string[] = [];
  const chars = [...text];
  // Syllables as [initial, vowel, final] indexes; anything else passes through.
  type Part = { c: string; i?: number; v?: number; f?: number };
  const parts: Part[] = chars.map(c => {
    const n = c.charCodeAt(0) - 0xAC00;
    return n >= 0 && n <= 11171 ? { i: Math.floor(n / 588), v: Math.floor((n % 588) / 28), f: n % 28, c } : { c };
  });
  parts.forEach((p, k) => {
    if (p.v === undefined || p.i === undefined || p.f === undefined) { out.push(p.c); return; }
    const prev = parts[k - 1], next = parts[k + 1];
    // A final consonant followed by a vowel sound moves to the next syllable.
    let initial = INITIAL[p.i];
    if (prev?.f !== undefined && p.i === 11 && prev.f in CARRY) initial = prev.f === 27 ? "" : INITIAL[CARRY[prev.f]];
    const carried = next?.i === 11 && p.f in CARRY;
    out.push(initial + VOWEL[p.v] + (carried ? "" : FINAL[p.f]));
  });
  return out.join("").replace(/\s+/g, " ").trim();
}

// ---------- Kana: Hepburn ----------
const KANA_BASE: Record<string, string> = {
  あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko", さ: "sa", し: "shi", す: "su", せ: "se", そ: "so",
  た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to", な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
  ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo", ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", ゐ: "i", ゑ: "e", を: "o", ん: "n",
  が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo", だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do",
  ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo", ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", ゔ: "vu",
};
const SMALL_Y: Record<string, string> = { ゃ: "a", ゅ: "u", ょ: "o" };
const SMALL_V: Record<string, string> = { ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o" };
const PUNCT: Record<string, string> = { "、": ",", "。": ".", "・": " ", "「": "\"", "」": "\"", "！": "!", "？": "?", "　": " " };

/** Katakana to hiragana, so one table reads both; the long mark and punctuation stay. */
const hira = (s: string) => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

export function romanizeKana(text: string): string {
  const chars = [...hira(text)];
  let out = "", double = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "っ") { double = true; continue; }
    if (c === "ー") { const v = out.match(/[aiueo](?=[^aiueo]*$)/)?.[0]; if (v) out += v; continue; }
    let r = KANA_BASE[c];
    if (r === undefined) { out += PUNCT[c] ?? c; double = false; continue; }
    const next = chars[i + 1];
    if (next && SMALL_Y[next]) {
      // きゃ → kya, しゃ → sha, じゃ → ja
      r = /^(sh|ch|j)i$/.test(r) ? r.slice(0, -1) + SMALL_Y[next] : r.slice(0, -1) + "y" + SMALL_Y[next]; i++;
    } else if (next && SMALL_V[next]) {
      // ふぁ → fa, てぃ → ti, うぃ → wi, しぇ → she
      const stem = r.replace(/[aiueo]+$/, "");
      r = (stem === "" ? "w" : stem) + SMALL_V[next]; i++;
    }
    if (double) { r = (r.startsWith("ch") ? "t" : r[0]) + r; double = false; }
    // ん before a vowel or y is marked, so "kon'ya" is not read "konya".
    if (c === "ん" && /^[aiueoy]/.test(KANA_BASE[chars[i + 1]] ?? "")) r = "n'";
    out += r;
  }
  return out.replace(/\s+/g, " ").trim();
}

// ---------- Chinese: pinyin ----------
export async function romanizeChinese(text: string): Promise<string> {
  const { pinyin } = await import("pinyin-pro");
  return pinyin(text, { toneType: "symbol", nonZh: "consecutive", type: "string" }).replace(/\s+/g, " ").trim();
}

/** Why a line cannot be romanized by rule: kanji in Japanese, or a script with no rule here. */
export const needsModel = (text: string) => { const s = scriptOf(text); return s === "other" || (s === "kana" && HAN.test(text)); };

/** A line romanized by rule, or null when it is already Latin or needs the model. Chinese needs a dictionary and is async. */
export async function romanizeLocal(text: string, language?: string): Promise<string | null> {
  const s = scriptOf(text);
  if (s === "latin") return null;
  if (s === "hangul") return romanizeHangul(text);
  if (s === "kana") return HAN.test(text) ? null : romanizeKana(text);
  if (s === "han") return language === "ja" ? null : romanizeChinese(text);
  return null;
}
