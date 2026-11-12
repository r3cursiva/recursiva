// Times in the activity feed: "3 hours ago" in the text, the exact time in the tooltip.
import { clockOrDate, compactAge } from "@rsva/display/time";
import { useEffect, useState } from "react";

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const exact = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

/** "just now", "5 minutes ago", "yesterday", "3 weeks ago". */
export function timeAgo(iso: string, now: number): string {
  const s = (Date.parse(iso) - now) / 1000;
  if (Math.abs(s) < 45) return "just now";
  const [unit, n] = UNITS.find(([, n]) => Math.abs(s) >= n) ?? UNITS.at(-1)!;
  return relative.format(Math.round(s / n), unit);
}

export function exactTime(iso: string): string {
  return exact.format(new Date(iso));
}


/** A row's small time: "40m", "2h" for the last hours, "10:05" earlier today, then "Oct 29". */
export function shortTime(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  return ms < 12 * 3_600_000 ? compactAge(ms) : clockOrDate(iso, now);
}

/** The current time, re-read every minute so relative times stay right while a feed is open. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}
