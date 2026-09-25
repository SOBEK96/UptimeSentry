import { useEffect, useState } from "react";
import type { SyncState } from "../lib/useSnapshot";
import type { Wallet } from "../lib/wallet";
import { CONTRACT_ADDRESS, EXPLORER_URL, NETWORK_LABEL } from "../lib/network";
import { ago, formatGen, shortAddr } from "../lib/format";
import { DEMO_ACCOUNT, type DemoReason } from "../lib/demo";
import { Badge, Button, Dot, Mono } from "./ui";
import { cx } from "./styles";

export function SyncIndicator({ sync, onRetry, demo }: { sync: SyncState; onRetry: () => void; demo: DemoReason | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (demo === "guest") return <Badge tone="sky" dot>Sample telemetry</Badge>;
  if (sync.kind === "loading") return <Badge tone="zinc" dot pulse>Syncing contract…</Badge>;
  if (sync.kind === "live") return <Badge tone="emerald" dot>Synced {ago(sync.at)}</Badge>;
  const why = sync.reason === "busy" ? "RPC busy" : "RPC unreachable";
  if (sync.kind === "retrying")
    return (
      <Badge tone="amber" dot pulse>
        {why} · retrying{demo ? " · showing sample telemetry" : sync.lastAt ? ` · showing ${ago(sync.lastAt)}` : ""}
      </Badge>
    );
  return (
    <button onClick={onRetry} className="rounded-full" title="Retry now">
      <Badge tone="amber" dot className="hover:bg-amber-500/20">
        {why} · {demo ? "showing sample telemetry" : sync.lastAt ? `showing data from ${ago(sync.lastAt)}` : "no data yet"} · retry
      </Badge>
    </button>
  );
}

interface HeaderProps {
  wallet: Wallet;
  balance: bigint | null;
  sync: SyncState;
  onRetry: () => void;
  demo: DemoReason | null;
  onGuest: () => void;
  onExitGuest: () => void;
}

export function Header({ wallet, balance, sync, onRetry, demo, onGuest, onExitGuest }: HeaderProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4 py-5">
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10 shadow-[0_0_30px_-8px_rgb(52_211_153/0.7)]">
          <svg viewBox="0 0 32 32" className="size-6 text-emerald-300" aria-hidden>
            <path d="M3 18h7l3-9 5 15 3-8h8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-white">UptimeSentry</h1>
          <p className="text-xs text-zinc-500">SLA insurance, adjudicated by GenLayer consensus</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href={CONTRACT_ADDRESS && EXPLORER_URL ? `${EXPLORER_URL}/address/${CONTRACT_ADDRESS}` : undefined}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 px-3 text-xs text-zinc-300 backdrop-blur hover:border-zinc-600"
        >
          <Dot tone="emerald" pulse />
          {NETWORK_LABEL}
          {CONTRACT_ADDRESS && <Mono className="text-zinc-500">{shortAddr(CONTRACT_ADDRESS)}</Mono>}
        </a>
        <SyncIndicator sync={sync} onRetry={onRetry} demo={demo} />
        {demo ? <GuestBadge balance={balance} onExit={onExitGuest} /> : <WalletBadge wallet={wallet} balance={balance} onGuest={onGuest} />}
      </div>
    </header>
  );
}

function GuestBadge({ balance, onExit }: { balance: bigint | null; onExit: () => void }) {
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-indigo-400/30 bg-indigo-500/10 pl-1 pr-1 text-xs backdrop-blur">
      <span className="grid size-6 place-items-center rounded-full bg-gradient-to-br from-indigo-400 to-sky-400 text-[10px] font-bold text-zinc-950">G</span>
      <span className="text-indigo-100">Studio guest</span>
      <Mono className="text-zinc-400">{shortAddr(DEMO_ACCOUNT)}</Mono>
      {balance !== null && <Mono className="text-zinc-400">{formatGen(balance, 2)} GEN</Mono>}
      <button onClick={onExit} className="rounded-full px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Leave guest mode">
        exit
      </button>
    </span>
  );
}

function WalletBadge({ wallet, balance, onGuest }: { wallet: Wallet; balance: bigint | null; onGuest: () => void }) {
  if (!wallet.address)
    return (
      <>
        <Button size="sm" variant="ghost" onClick={onGuest} className="h-8 rounded-full" title="Explore every feature with sample data and a demo balance. No wallet or funds needed.">
          Try as Studio guest
        </Button>
        <Button size="sm" onClick={wallet.connect} disabled={wallet.connecting} className="h-8 rounded-full">
          {wallet.connecting ? "Connecting…" : "Connect wallet"}
        </Button>
      </>
    );
  if (!wallet.chainOk)
    return (
      <Button size="sm" variant="ghost" onClick={wallet.switchChain} className="h-8 rounded-full border-amber-500/40 text-amber-200">
        Switch to {NETWORK_LABEL}
      </Button>
    );
  return (
    <span className={cx("inline-flex h-8 items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 pl-1 pr-3 text-xs backdrop-blur")}>
      <span className="grid size-6 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-sky-500 text-[10px] font-bold text-zinc-950">
        {wallet.address.slice(2, 4).toUpperCase()}
      </span>
      <Mono className="text-zinc-200">{shortAddr(wallet.address)}</Mono>
      {balance !== null && <Mono className="text-zinc-500">{formatGen(balance, 3)} GEN</Mono>}
    </span>
  );
}
