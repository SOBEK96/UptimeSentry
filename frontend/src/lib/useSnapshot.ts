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

/**
 * Reads the full contract state and keeps the last good copy. Reads run one
 * after another rather than in parallel so a page load costs one execution
 * slot at a time on the shared RPC. When the RPC is busy the previous snapshot
 * stays on screen and the sync state says so.
 */
export function useSnapshot() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [sync, setSync] = useState<SyncState>({ kind: "loading" });
  const lastAt = useRef<number | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!CONTRACT_ADDRESS || inFlight.current) return;
    inFlight.current = true;
    let reason: "busy" | "network" = "network";
    const retry = {
      retries: 3,
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
      setData({ stats, providers, policies, claims });
      lastAt.current = Date.now();
      setSync({ kind: "live", at: lastAt.current });
    } catch (err) {
      console.warn("[UptimeSentry] contract read failed", err);
      setSync({ kind: "stale", reason: isBusy(err) ? "busy" : reason, lastAt: lastAt.current });
    } finally {
      inFlight.current = false;
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
