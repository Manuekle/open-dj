import { describe, expect, it } from "vitest";
import { needsModel, romanizeHangul, romanizeKana, romanizeLocal, scriptOf } from "@/lib/romanize";

describe("romanize", () => {
  it("names the script of a line", () => {
    expect(scriptOf("hello")).toBe("latin");
    expect(scriptOf("사랑해")).toBe("hangul");
    expect(scriptOf("ありがとう")).toBe("kana");
    expect(scriptOf("你好")).toBe("han");
    expect(scriptOf("привет")).toBe("other");
  });

  it("romanizes Hangul by the Revised Romanization", () => {
    expect(romanizeHangul("사랑해")).toBe("saranghae");
    expect(romanizeHangul("안녕하세요")).toBe("annyeonghaseyo");
    expect(romanizeHangul("한국어")).toBe("hangugeo");
    expect(romanizeHangul("좋아 love")).toBe("joa love");
  });

  it("romanizes kana by Hepburn", () => {
    expect(romanizeKana("ありがとう")).toBe("arigatou");
    expect(romanizeKana("こんにちは")).toBe("konnichiha");
    expect(romanizeKana("きょう")).toBe("kyou");
    expect(romanizeKana("しゃしん")).toBe("shashin");
    expect(romanizeKana("がっこう")).toBe("gakkou");
    expect(romanizeKana("まっちゃ")).toBe("matcha");
    expect(romanizeKana("ファイト")).toBe("faito");
    expect(romanizeKana("コーヒー")).toBe("koohii");
    expect(romanizeKana("ほんや")).toBe("hon'ya");
  });

  it("sends kanji and other scripts to the model and leaves Latin alone", async () => {
    expect(needsModel("愛してる")).toBe(true);
    expect(needsModel("ありがとう")).toBe(false);
    expect(needsModel("привет")).toBe(true);
    expect(await romanizeLocal("愛してる", "ja")).toBeNull();
    expect(await romanizeLocal("hello", "en")).toBeNull();
  });

  it("writes Chinese as pinyin with tone marks", async () => {
    expect(await romanizeLocal("你好", "zh")).toBe("nǐ hǎo");
  });
});
