// "Chrome on macOS": what a person's lists call a device, from its User-Agent header. Only for showing: a client can say
// what it likes here, and the answer is always one of these fixed words.
const BROWSERS: [RegExp, string][] = [
  // `rsva login` (apps/cli): a signed-in terminal.
  [/^rsva\//, "Terminal"],
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad/, "iOS"],
  [/Android/, "Android"],
  [/Mac OS X/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

const first = (ua: string, names: [RegExp, string][]) => names.find(([re]) => re.test(ua))?.[1];

export function deviceName(userAgent: string | null | undefined): string {
  if (!userAgent) return "Unknown device";
  const browser = first(userAgent, BROWSERS) ?? "Browser";
  const os = first(userAgent, SYSTEMS);
  return os ? `${browser} on ${os}` : browser;
}
