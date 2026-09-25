import { useCallback, useEffect, useRef, useState } from "react";
import type { Claim, Policy, ProtocolStats, Provider } from "./types";
import { views } from "./contract";
import { isBusy } from "./rpc";
import { CONTRACT_ADDRESS } from "./network";

export interface Snapshot {
  stats: ProtocolStats;
  providers: Provider[];
  policies: Policy[];
  claims: Claim[];
}

export type SyncState =
  | { kind: "loading" }
  | { kind: "live"; at: number }
  | { kind: "retrying"; reason: "busy" | "network"; lastAt: number | null }
  | { kind: "stale"; reason: "busy" | "network"; lastAt: number | null };

const POLL_MS = 30_000;
const CACHE_KEY = `uptimesentry:snapshot:${CONTRACT_ADDRESS ?? "none"}`;

// The last good read is kept in localStorage so a reload while the RPC is down
// still shows real contract state. Bigints are tagged to survive JSON.
function saveCache(data: Snapshot, at: number) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at, data }, (_, v) => (typeof v === "bigint" ? { $big: v.toString() } : v)));
  } catch {
    // Storage full or blocked: the in-memory copy still covers this session.
  }
}

function loadCache(): { at: number; data: Snapshot } | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw, (_, v) => (v && typeof v === "object" && typeof v.$big === "string" ? BigInt(v.$big) : v));
  } catch {
    return null;
  }
}

/**
 * Reads the full contract state and keeps the last good copy. Reads run one
 * after another rather than in parallel so a page load costs one execution
 * slot at a time on the shared RPC. When the RPC is busy the previous snapshot
 * stays on screen and the sync state says so.
 */
export function useSnapshot() {
  const [cached] = useState(loadCache);
  const [data, setData] = useState<Snapshot | null>(cached?.data ?? null);
  const [sync, setSync] = useState<SyncState>({ kind: "loading" });
  const lastAt = useRef<number | null>(cached?.at ?? null);
  const inFlight = useRef<Promise<boolean> | null>(null);

  /** Resolves true when a fresh snapshot was read. A failed read never clears
   * what is on screen. A manual retry passes fewer retries so it answers fast. */
  const refresh = useCallback((retries = 3): Promise<boolean> => {
    if (!CONTRACT_ADDRESS) return Promise.resolve(false);
    inFlight.current ??= load().finally(() => (inFlight.current = null));
    return inFlight.current;

    async function load(): Promise<boolean> {
      let reason: "busy" | "network" = "network";
      const retry = {
        retries,
        baseDelayMs: 1500,
        onRetry: (_: number, err: unknown) => {
          reason = isBusy(err) ? "busy" : "network";
          setSync({ kind: "retrying", reason, lastAt: lastAt.current });
        },
      };
      try {
        const stats = await views.stats(retry);
        const providers = await views.providers(retry);
        const policies = await views.policies(retry);
        const claims = await views.claims(retry);
        const snapshot = { stats, providers, policies, claims };
        setData(snapshot);
        lastAt.current = Date.now();
        saveCache(snapshot, lastAt.current);
        setSync({ kind: "live", at: lastAt.current });
        return true;
      } catch (err) {
        console.warn("[UptimeSentry] contract read failed", err);
        setSync({ kind: "stale", reason: isBusy(err) ? "busy" : reason, lastAt: lastAt.current });
        return false;
      }
    }
  }, []);

  useEffect(() => {
    // Initial load and polling; every setState happens after network reads resolve.
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh();
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  return { data, sync, refresh };
}
