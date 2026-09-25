const ATTO = 10n ** 18n;

export function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string" && v !== "") return BigInt(v);
  return 0n;
}

export function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v !== "") return Number(v);
  return 0;
}

export function formatGen(atto: bigint, digits = 4): string {
  const negative = atto < 0n;
  const abs = negative ? -atto : atto;
  const whole = abs / ATTO;
  const frac = (abs % ATTO).toString().padStart(18, "0").slice(0, digits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

export function parseGen(input: string): bigint | null {
  const s = input.trim();
  if (!/^\d+(\.\d{0,18})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * ATTO + BigInt(frac.padEnd(18, "0"));
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatTime(unix: number): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export function sameAddr(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 172_800) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
