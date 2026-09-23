import { useEffect, useState } from "react";
import type { ProbeKind } from "./types";

export type BrowserProbe =
  | { state: "pending" }
  | { state: "ok"; ms: number; status: number; healthy: boolean }
  | { state: "blocked" };

/** One request from the viewer's browser to the endpoint, timed. This is the
 * viewer's own vantage point, not a consensus observation; endpoints that
 * don't allow cross-origin requests report "blocked". */
export async function probeFromBrowser(url: string, kind: ProbeKind, payload: string, timeoutMs = 8000): Promise<BrowserProbe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method: kind === "JSONRPC" ? "POST" : "GET",
      headers: kind === "JSONRPC" ? { "Content-Type": "application/json" } : undefined,
      body: kind === "JSONRPC" ? payload : undefined,
      signal: ctrl.signal,
      cache: "no-store",
    });
    const ms = Math.round(performance.now() - start);
    let healthy = res.ok;
    if (healthy && kind === "JSONRPC") {
      const body = (await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null;
      healthy = !!body && body.error == null && body.result != null;
    }
    return { state: "ok", ms, status: res.status, healthy };
  } catch {
    return { state: "blocked" };
  } finally {
    clearTimeout(timer);
  }
}

export function useBrowserProbe(url: string, kind: ProbeKind, payload: string, everyMs = 30_000) {
  const [probe, setProbe] = useState<BrowserProbe>({ state: "pending" });
  useEffect(() => {
    let live = true;
    const measure = () => void probeFromBrowser(url, kind, payload).then((p) => live && setProbe(p));
    measure();
    const t = setInterval(() => document.visibilityState === "visible" && measure(), everyMs);
    const onVisible = () => document.visibilityState === "visible" && measure();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [url, kind, payload, everyMs]);
  return probe;
}
