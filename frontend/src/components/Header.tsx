import { useEffect, useState } from "react";
import type { SyncState } from "../lib/useSnapshot";
import type { Wallet } from "../lib/wallet";
import { CONTRACT_ADDRESS, EXPLORER_URL, NETWORK_LABEL } from "../lib/network";
import { formatGen, shortAddr } from "../lib/format";
import { Badge, Button, Dot, Mono } from "./ui";
import { cx } from "./styles";

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 5 ? "just now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`;
}

export function SyncIndicator({ sync, onRetry }: { sync: SyncState; onRetry: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (sync.kind === "loading") return <Badge tone="zinc" dot pulse>Syncing contract…</Badge>;
  if (sync.kind === "live") return <Badge tone="emerald" dot>Synced {ago(sync.at)}</Badge>;
  const why = sync.reason === "busy" ? "RPC busy" : "RPC unreachable";
  if (sync.kind === "retrying")
    return (
      <Badge tone="amber" dot pulse>
        {why} · retrying{sync.lastAt ? ` · showing ${ago(sync.lastAt)}` : ""}
      </Badge>
    );
  return (
    <button onClick={onRetry} className="rounded-full" title="Retry now">
      <Badge tone="amber" dot className="hover:bg-amber-500/20">
        {why} · {sync.lastAt ? `showing data from ${ago(sync.lastAt)}` : "no data yet"} · retry
      </Badge>
    </button>
  );
}

export function Header({ wallet, balance, sync, onRetry }: { wallet: Wallet; balance: bigint | null; sync: SyncState; onRetry: () => void }) {
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
        <SyncIndicator sync={sync} onRetry={onRetry} />
        <WalletBadge wallet={wallet} balance={balance} />
      </div>
    </header>
  );
}

function WalletBadge({ wallet, balance }: { wallet: Wallet; balance: bigint | null }) {
  if (!wallet.address)
    return (
      <Button size="sm" onClick={wallet.connect} disabled={wallet.connecting} className="h-8 rounded-full">
        {wallet.connecting ? "Connecting…" : "Connect wallet"}
      </Button>
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
