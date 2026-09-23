import { useState } from "react";
import { formatDuration, formatGen, parseGen } from "../lib/format";
import { probeFromBrowser, type BrowserProbe } from "../lib/browserProbe";
import { Button, Card, Field, GenInput, Input } from "./ui";
import { cx, inputClass } from "./styles";

const METHODS = ["eth_blockNumber", "eth_chainId", "eth_syncing", "net_version", "getHealth", "getSlot", "getBlockHeight"];
const DOWNTIME_PRESETS = [5, 10, 30, 60, 240, 1440];
const AVAILABILITY_PRESETS = ["99.00", "99.50", "99.90", "99.99"];

export interface UnderwriteInput {
  name: string;
  url: string;
  kind: "JSONRPC" | "HTTP_GET";
  payload: string;
  maxDowntime: number;
  targetBps: number;
  premiumBps: number;
  pool: bigint;
}

function urlProblem(url: string): string | null {
  if (!url.startsWith("https://")) return "Must start with https://";
  try {
    const u = new URL(url);
    if (u.username || u.password || u.hash) return "No credentials or #fragments";
    if (!u.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.)/.test(u.hostname)) return "Must be a public domain";
    if ([...u.searchParams.keys()].some((k) => /key|token|secret|auth|sig|pass|session/i.test(k))) return "Remove API keys: endpoints must be keyless";
  } catch {
    return "Not a valid URL";
  }
  return null;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cx("h-8 rounded-lg border px-2.5 font-mono text-xs transition", on ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200" : "border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")}>
      {children}
    </button>
  );
}

export function Underwrite({ busy, minPool, balance, feeDeposit, connected, onSubmit }: { busy: boolean; minPool: bigint; balance: bigint | null; feeDeposit: bigint | null; connected: boolean; onSubmit: (i: UnderwriteInput) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [kind, setKind] = useState<"JSONRPC" | "HTTP_GET">("JSONRPC");
  const [method, setMethod] = useState(METHODS[0]);
  const [downtimeMin, setDowntimeMin] = useState(10);
  const [target, setTarget] = useState("99.90");
  const [premium, setPremium] = useState("2.00");
  const [pool, setPool] = useState(formatGen(minPool, 0));
  const [check, setCheck] = useState<BrowserProbe | null>(null);

  const poolAtto = parseGen(pool);
  const targetBps = Math.round(Number(target) * 100);
  const premiumBps = Math.round(Number(premium) * 100);
  const payload = kind === "JSONRPC" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }) : "";
  const urlIssue = url === "https://" ? null : urlProblem(url);
  const total = poolAtto !== null && feeDeposit !== null ? poolAtto + feeDeposit : null;
  const short = total !== null && balance !== null && balance < total;

  const problems = [
    !name.trim() && "Name the endpoint",
    (url === "https://" || urlIssue) && (urlIssue ?? "Enter the endpoint URL"),
    (poolAtto === null || poolAtto < minPool) && `Pool must be at least ${formatGen(minPool)} GEN`,
    (targetBps < 9000 || targetBps > 10000) && "Availability target must be 90–100%",
    (premiumBps < 1 || premiumBps > 5000) && "Premium must be 0.01–50%",
    short && "Wallet balance doesn't cover the pool plus fee deposit",
    !connected && "Connect a wallet",
  ].filter(Boolean) as string[];

  const test = async () => {
    setCheck({ state: "pending" });
    setCheck(await probeFromBrowser(url, kind, payload));
  };

  return (
    <form
      className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
      onSubmit={async (e) => {
        e.preventDefault();
        if (problems.length || poolAtto === null) return;
        await onSubmit({ name: name.trim(), url: url.trim(), kind, payload, maxDowntime: downtimeMin * 60, targetBps, premiumBps, pool: poolAtto });
      }}
    >
      <Card className="grid gap-5 p-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <h2 className="text-base font-semibold text-white">Underwrite an endpoint</h2>
          <p className="mt-1 text-sm text-zinc-400">Lock GEN behind a public, keyless endpoint. Confirmed breaches pay out from this pool and slash 20% of the payout from free capital.</p>
        </div>
        <Field label="Name">
          <Input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="Base Mainnet Public RPC" />
        </Field>
        <Field label="Public endpoint URL" hint={urlIssue ? <span className="text-amber-300">{urlIssue}</span> : undefined}>
          <div className="flex gap-2">
            <Input className="font-mono text-xs" value={url} onChange={(e) => (setUrl(e.target.value), setCheck(null))} spellCheck={false} />
            <Button type="button" size="sm" variant="ghost" className="h-10" disabled={!!urlIssue || url === "https://"} onClick={test}>
              Test
            </Button>
          </div>
        </Field>
        <Field label="Health check">
          <div className="flex gap-1.5">
            <Chip on={kind === "JSONRPC"} onClick={() => setKind("JSONRPC")}>JSON-RPC</Chip>
            <Chip on={kind === "HTTP_GET"} onClick={() => setKind("HTTP_GET")}>HTTP GET 2xx</Chip>
          </div>
        </Field>
        {kind === "JSONRPC" ? (
          <Field label="RPC method">
            <select className={cx(inputClass, "font-mono text-xs")} value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        ) : (
          <div />
        )}
        {check && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 font-mono text-xs sm:col-span-2">
            {check.state === "pending" && <span className="text-zinc-400">probing from your browser…</span>}
            {check.state === "blocked" && <span className="text-amber-300">No readable response from your browser (CORS, TLS or timeout). Validators probe server-side, so this may still work.</span>}
            {check.state === "ok" && (
              <span className={check.healthy ? "text-emerald-300" : "text-rose-300"}>
                HTTP {check.status} in {check.ms} ms · {check.healthy ? "healthy: validators should see it as up" : "unhealthy: registering a failing endpoint invites immediate claims"}
              </span>
            )}
          </div>
        )}
        <Field label={`Allowed downtime · ${formatDuration(downtimeMin * 60)}`} hint="How long an outage must persist before it's a breach" className="sm:col-span-2">
          <div className="flex flex-wrap gap-1.5">
            {DOWNTIME_PRESETS.map((m) => (
              <Chip key={m} on={downtimeMin === m} onClick={() => setDowntimeMin(m)}>
                {formatDuration(m * 60)}
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Availability target" hint="Published next to consensus-observed uptime">
          <div className="flex flex-wrap gap-1.5">
            {AVAILABILITY_PRESETS.map((a) => (
              <Chip key={a} on={target === a} onClick={() => setTarget(a)}>
                {a}%
              </Chip>
            ))}
          </div>
        </Field>
        <Field label="Premium per 30 days" hint="Percent of coverage a subscriber pays">
          <GenInput suffix="%" value={premium} onChange={(e) => setPremium(e.target.value)} />
        </Field>
      </Card>

      <Card className="flex flex-col gap-4 p-5">
        <Field label="Underwriting pool" hint={`Minimum ${formatGen(minPool)} GEN`}>
          <GenInput value={pool} onChange={(e) => setPool(e.target.value)} className="h-12 text-lg" />
        </Field>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 font-mono text-xs">
          <div className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">Cost breakdown</div>
          <Row k="Pool deposit (to contract)" v={poolAtto} />
          <Row k="Consensus fee deposit" v={feeDeposit} />
          <div className="mt-2 flex justify-between border-t border-zinc-800 pt-2 text-sm text-white">
            <span>Total from wallet</span>
            <span>{total === null ? "…" : `${formatGen(total, 4)} GEN`}</span>
          </div>
          {balance !== null && (
            <div className={cx("mt-1 flex justify-between", short ? "text-rose-300" : "text-zinc-500")}>
              <span>Wallet balance</span>
              <span>{formatGen(balance, 4)} GEN</span>
            </div>
          )}
        </div>
        <ul className="grid gap-1 text-xs text-zinc-400">
          <li>• Withdraw free capital any time no claim is open.</li>
          <li>• Premiums from subscribers are added to the pool.</li>
          <li>• A probe with {kind === "JSONRPC" ? method : "GET"} defines &ldquo;healthy&rdquo; for every claim.</li>
        </ul>
        {problems.length > 0 && <p className="text-xs text-amber-300">{problems[0]}.</p>}
        <Button className="mt-auto h-11" disabled={busy || problems.length > 0}>
          Lock {poolAtto !== null ? formatGen(poolAtto) : "…"} GEN and register
        </Button>
      </Card>
    </form>
  );
}

function Row({ k, v }: { k: string; v: bigint | null }) {
  return (
    <div className="flex justify-between py-0.5 text-zinc-400">
      <span>{k}</span>
      <span className="text-zinc-200">{v === null ? "…" : `${formatGen(v, 6)} GEN`}</span>
    </div>
  );
}
