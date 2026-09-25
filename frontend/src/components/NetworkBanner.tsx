import { useState } from "react";
import type { ReactNode } from "react";
import type { SyncState } from "../lib/useSnapshot";
import type { DemoReason } from "../lib/demo";
import { NETWORK_LABEL } from "../lib/network";
import { ago } from "../lib/format";
import { Button, Dot } from "./ui";
import { cx, type Tone } from "./styles";

const FRAME: Record<Tone, string> = {
  amber: "border-amber-500/30 bg-amber-500/[0.06]",
  sky: "border-indigo-400/30 bg-indigo-500/[0.07]",
  emerald: "border-emerald-500/30 bg-emerald-500/[0.06]",
  rose: "border-rose-500/30 bg-rose-500/[0.06]",
  zinc: "border-zinc-700 bg-zinc-900/60",
};

function Frame({ tone, pulse, children, actions }: { tone: Tone; pulse?: boolean; children: ReactNode; actions: ReactNode }) {
  return (
    <div role="status" className={cx("mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 backdrop-blur-md", FRAME[tone])}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-1.5">
          <Dot tone={tone} pulse={pulse} />
        </span>
        <p className="text-sm text-zinc-300">{children}</p>
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

interface Props {
  demo: { active: boolean; reason: DemoReason | null };
  sync: SyncState;
  hasData: boolean;
  liveEmpty: boolean;
  onRetry: () => Promise<void>;
  onGuest: () => void;
  onExitDemo: () => void;
  onResetDemo: () => void;
}

/** One line under the header that says where the numbers on screen come from
 * and what to do about it. Never blocks the page. */
export function NetworkBanner({ demo, sync, hasData, liveEmpty, onRetry, onGuest, onExitDemo, onResetDemo }: Props) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  // Clickable during background retries too: refresh joins a read in flight.
  const busy = retrying;
  const RetryButton = (
    <Button size="sm" variant="ghost" onClick={retry} disabled={busy} className="border-amber-500/40 text-amber-100">
      {busy ? "Connecting…" : "Retry connection"}
    </Button>
  );

  if (demo.active && demo.reason === "rpc") {
    if (sync.kind === "live")
      return (
        <Frame
          tone="emerald"
          actions={
            <>
              <Button size="sm" variant="success" onClick={onExitDemo}>
                Switch to live contract
              </Button>
              <Button size="sm" variant="ghost" onClick={onGuest}>
                Keep exploring samples
              </Button>
            </>
          }
        >
          {NETWORK_LABEL} RPC is reachable again. You are still looking at sample telemetry.
        </Frame>
      );
    return (
      <Frame tone="amber" pulse actions={RetryButton}>
        <strong className="font-medium text-amber-200">{NETWORK_LABEL} RPC is temporarily slow or unreachable.</strong> Showing interactive sample telemetry. Every
        action works, but runs the contract&rsquo;s rules in your browser: nothing is signed or sent.
      </Frame>
    );
  }

  if (demo.active)
    return (
      <Frame
        tone="sky"
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={onResetDemo}>
              Reset sample data
            </Button>
            <Button size="sm" variant="ghost" onClick={onExitDemo}>
              Exit guest mode
            </Button>
          </>
        }
      >
        <strong className="font-medium text-indigo-200">Studio guest mode.</strong> Sample endpoints, policies and claims with a 250 GEN demo balance. Subscribe, file
        incidents, appeal, sample and settle: the contract&rsquo;s rules run in your browser and nothing is signed.
      </Frame>
    );

  if (hasData && (sync.kind === "stale" || sync.kind === "retrying"))
    return (
      <Frame
        tone="amber"
        actions={
          <>
            {RetryButton}
            <Button size="sm" variant="ghost" onClick={onGuest}>
              Explore sample telemetry
            </Button>
          </>
        }
      >
        <strong className="font-medium text-amber-200">{NETWORK_LABEL} RPC is {sync.reason === "busy" ? "at capacity" : "temporarily unreachable"}.</strong> Showing the
        last contract state read {sync.lastAt ? ago(sync.lastAt) : "earlier"}. It refreshes as soon as the RPC answers.
      </Frame>
    );

  if (liveEmpty && sync.kind === "live")
    return (
      <Frame
        tone="sky"
        actions={
          <Button size="sm" onClick={onGuest}>
            Explore with sample telemetry
          </Button>
        }
      >
        The live contract is reachable but no endpoints are insured yet. Underwrite one below, or explore a populated protocol as a Studio guest.
      </Frame>
    );

  return null;
}
