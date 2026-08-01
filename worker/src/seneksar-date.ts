export type CalendarDate = { year: number; month: number; day: number };

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function shiftDate(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days, 12));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function monthDay(date: CalendarDate): string {
  return `${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function seneksarDateKeyForCairoDate(date: CalendarDate): string {
  if (isLeapYear(date.year + 1) && date.month >= 9) {
    if (date.month > 9 || (date.month === 9 && date.day > 11)) {
      return monthDay(shiftDate(date, -1));
    }
    if (date.month === 9 && date.day === 11) return "02-29";
  } else if (isLeapYear(date.year) && date.month < 3) {
    return monthDay(shiftDate(date, -1));
  }
  return monthDay(date);
}

export function cairoCalendarDate(now = new Date(), offsetDays = 0): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return shiftDate({ year: value("year"), month: value("month"), day: value("day") }, offsetDays);
}

export function relativeSeneksarDateKey(normalizedQuery: string, now = new Date()): string | undefined {
  if (["بكره", "بكرة", "غدا", "غداً", "tomorrow"].some((term) => normalizedQuery.includes(term))) {
    return seneksarDateKeyForCairoDate(cairoCalendarDate(now, 1));
  }
  if (["النهارده", "النهاردة", "اليوم", "today"].some((term) => normalizedQuery.includes(term))) {
    return seneksarDateKeyForCairoDate(cairoCalendarDate(now));
  }
  return undefined;
}