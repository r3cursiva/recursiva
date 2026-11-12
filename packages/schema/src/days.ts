// Calendar days as YYYY-MM-DD: the arithmetic every package shares (cycles, date filters, due dates, feeds' day groups).
// A day string carries no zone, so adding and counting days is done on its UTC midnight; only `localDay` reads a zone,
// the runtime's (the viewer's browser, or the server's).

const DAY_MS = 86_400_000;
const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);

/** The day `days` after `day`; negative goes back. */
export function addDays(day: string, days: number): string {
  return new Date(utc(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Days from `a` to `b`: 0 for the same day, negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

/** The local day of a moment, in the runtime's zone. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of a moment in an IANA zone, as a UTC timestamp of the same digits. */
function wallMs(at: number, timeZone: string): number {
  let f = zoneFormats.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    zoneFormats.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
}

/** The day of a moment in `timeZone` (the person's), or in the runtime's zone when it is absent. */
export function dayIn(d: Date, timeZone?: string): string {
  return timeZone ? new Date(wallMs(d.getTime(), timeZone)).toISOString().slice(0, 10) : localDay(d);
}

/**
 * The moment a day starts in `timeZone`, or in the runtime's zone when it is absent. A midnight a clock change skips
 * comes out as the first moment of the day that exists.
 */
export function dayStart(day: string, timeZone?: string): Date {
  if (!timeZone) return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
  const wall = utc(day);
  // The zone's offset at a first guess, then at the moment it gives: the second is right across a clock change.
  const guess = wall - (wallMs(wall, timeZone) - wall);
  const t = wall - (wallMs(guess, timeZone) - guess);
  return new Date(dayIn(new Date(t), timeZone) < day ? guess : t);
}
