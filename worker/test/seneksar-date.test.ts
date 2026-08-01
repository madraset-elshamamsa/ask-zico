import { describe, expect, test } from "vitest";
import { seneksarDateKeyForCairoDate } from "../src/seneksar-date";

describe("seneksarDateKeyForCairoDate", () => {
  test("maps ordinary Cairo calendar dates to the fixed Seneksar month-day key", () => {
    expect(seneksarDateKeyForCairoDate({ year: 2026, month: 7, day: 16 })).toBe("07-16");
  });

  test("applies the site leap-year shift after Coptic New Year", () => {
    expect(seneksarDateKeyForCairoDate({ year: 2027, month: 9, day: 12 })).toBe("09-11");
    expect(seneksarDateKeyForCairoDate({ year: 2028, month: 2, day: 29 })).toBe("02-28");
  });

  test("keeps the small Coptic month on the special September boundary", () => {
    expect(seneksarDateKeyForCairoDate({ year: 2027, month: 9, day: 11 })).toBe("02-29");
  });
});