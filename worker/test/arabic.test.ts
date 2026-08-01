import { describe, expect, test } from "vitest";
import { normalizeArabicForSearch } from "../src/arabic";

describe("normalizeArabicForSearch", () => {
  test("normalizes Arabic query text without touching non-Arabic terms", () => {
    expect(normalizeArabicForSearch("إِزّاي أتعلم عن رؤيا الملاءة وⲠⲓⲛⲟⲩϯ?")).toBe(
      "ازاي اتعلم عن رويا الملاءه وⲠⲓⲛⲟⲩϯ",
    );
  });

  test("collapses whitespace and punctuation into searchable spacing", () => {
    expect(normalizeArabicForSearch("  آباؤنا...  في   السَّماء! ")).toBe(
      "اباونا في السماء",
    );
  });

  test("canonicalizes curated biblical name aliases", () => {
    const canonical = normalizeArabicForSearch("ملكي صادق");

    expect(normalizeArabicForSearch("ملشي صادق")).toBe(canonical);
    expect(normalizeArabicForSearch("ملشيصادق")).toBe(canonical);
    expect(normalizeArabicForSearch("ملكيصادق")).toBe(canonical);
  });

  test("canonicalizes the common shortened Omonogenis spelling", () => {
    expect(normalizeArabicForSearch("أومونوجينس")).toBe(
      normalizeArabicForSearch("أومونوجينيس"),
    );
  });
  test("canonicalizes source-backed Saint George names", () => {
    const canonical = normalizeArabicForSearch("القديس جورجيوس");

    expect(normalizeArabicForSearch("مار جرجس")).toBe(canonical);
    expect(normalizeArabicForSearch("مارجرجس")).toBe(canonical);
  });

  test("canonicalizes commemoration terms only when paired with a saint title", () => {
    expect(normalizeArabicForSearch("شهادة القديس جورجيوس")).toBe(
      normalizeArabicForSearch("استشهاد القديس جورجيوس"),
    );
    expect(normalizeArabicForSearch("انتقال القديسة دميانة")).toBe(
      normalizeArabicForSearch("نياحة القديسة دميانة"),
    );
    expect(normalizeArabicForSearch("موت الأنبا أنطونيوس")).toBe(
      normalizeArabicForSearch("نياحة الأنبا أنطونيوس"),
    );

    expect(normalizeArabicForSearch("شهادة حق")).toBe("شهاده حق");
    expect(normalizeArabicForSearch("انتقال الشعب")).toBe("انتقال الشعب");
  });

});
