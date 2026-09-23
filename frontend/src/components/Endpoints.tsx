import { useEffect, useState } from "react";
import type { Provider } from "../lib/types";
import { views } from "../lib/contract";
import { useBrowserProbe } from "../lib/browserProbe";
import { formatBps, formatDuration, formatGen, parseGen, sameAddr, shortAddr } from "../lib/format";
import { Badge, Button, Card, Empty, Field, GenInput, Mono, Stat } from "./ui";
import { cx } from "./styles";

interface Props {
  providers: Provider[];
  account: string | null;
  balance: bigint | null;
  feeDeposit: bigint | null;
  busy: boolean;
  onBuy: (p: Provider, coverage: bigint, termDays: number, premium: bigint) => Promise<boolean>;
  onProbe: (p: Provider) => void;
  onAddCapital: (p: Provider, amount: bigint) => Promise<boolean>;
  onFileIncident: (p: Provider) => void;
  onGoUnderwrite: () => void;
}

export function Endpoints(props: Props) {
  if (props.providers.length === 0) {
    return (
      <Empty title="No endpoints are underwritten yet.">
        <p className="max-w-sm text-sm text-zinc-500">Lock GEN behind a public RPC or health endpoint to start selling SLA coverage against it.</p>
        <Button onClick={props.onGoUnderwrite}>Underwrite an endpoint</Button>
      </Empty>
    );
  }
  return (
    <div className="grid gap-4">
      {props.providers.map((p) => (
        <EndpointCard key={p.provider_id} p={p} {...props} />
      ))}
    </div>
  );
}

function LatencyMeter({ p }: { p: Provider }) {
  const probe = useBrowserProbe(p.endpoint_url, p.probe_kind, p.probe_payload);
  const ms = probe.state === "ok" ? probe.ms : null;
  // Rose is reserved for failures; a slow but healthy answer is amber.
  const tone = probe.state !== "ok" ? "zinc" : !probe.healthy ? "rose" : ms! < 500 ? "emerald" : "amber";
  const bar = { emerald: "bg-emerald-400", amber: "bg-amber-400", rose: "bg-rose-400", zinc: "bg-zinc-600" }[tone];
  const width = ms === null ? 0 : Math.min(100, (ms / 2000) * 100);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Latency from your browser</span>
        <Mono className={cx("text-sm", tone === "zinc" ? "text-zinc-500" : "text-zinc-100")}>
          {probe.state === "pending" ? "measuring…" : probe.state === "blocked" ? "not reachable from browser" : probe.healthy ? `${ms} ms` : `HTTP ${probe.status} · ${ms} ms`}
        </Mono>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div className={cx("h-full rounded-full transition-all duration-700", bar)} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

function UptimeBar({ p }: { p: Provider }) {
  const has = p.observed_availability_bps >= 0;
  const meeting = has && p.observed_availability_bps >= p.target_availability_bps;
  const floor = 9000;
  const pct = (bps: number) => `${Math.min(100, Math.max(0, ((bps - floor) / (10000 - floor)) * 100))}%`;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Consensus-observed uptime</span>
        <Mono className="text-sm text-zinc-100">
          {has ? formatBps(p.observed_availability_bps) : "no probes yet"}
          {has && <span className="text-zinc-500"> · {p.probes_total} probe{p.probes_total === 1 ? "" : "s"}</span>}
        </Mono>
      </div>
      <div className="relative mt-2 h-1.5 rounded-full bg-zinc-800">
        {has && <div className={cx("h-full rounded-full", meeting ? "bg-emerald-400" : "bg-rose-400")} style={{ width: pct(p.observed_availability_bps) }} />}
        <span className="absolute -top-1 h-3.5 w-0.5 rounded bg-zinc-300" style={{ left: pct(p.target_availability_bps) }} title={`SLA target ${formatBps(p.target_availability_bps)}`} />
      </div>
      <div className="mt-1 text-right text-[11px] text-zinc-500">SLA target {formatBps(p.target_availability_bps)}</div>
    </div>
  );
}

type Panel = null | "subscribe" | "capital";

function EndpointCard({ p, account, balance, feeDeposit, busy, onBuy, onProbe, onAddCapital, onFileIncident }: Props & { p: Provider }) {
  const [panel, setPanel] = useState<Panel>(null);
  const own = sameAddr(account, p.owner);
  const lastUp = p.last_probe_at === 0 ? null : p.last_probe_code === "UP";
  const status = lastUp === null ? { tone: "zinc" as const, text: "Awaiting first probe" } : lastUp ? { tone: "emerald" as const, text: "Operational" } : { tone: "rose" as const, text: `Outage · ${p.last_probe_code}` };
  const method = p.probe_kind === "JSONRPC" ? (JSON.parse(p.probe_payload) as { method: string }).method : "HTTP GET";
  const total = p.free_capital + p.committed_capital;
  const committedPct = total > 0n ? Number((p.committed_capital * 1000n) / total) / 10 : 0;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5 pb-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-white">{p.name}</h3>
            <Badge tone={status.tone} dot pulse={status.tone === "emerald"}>
              {status.text}
            </Badge>
            {!p.accepting && <Badge tone="zinc">Coverage paused</Badge>}
            {own && <Badge tone="sky">You underwrite this</Badge>}
          </div>
          <Mono className="mt-1 block break-all text-xs text-zinc-400">{p.endpoint_url}</Mono>
        </div>
        <div className="flex flex-wrap gap-2">
          {!own && p.accepting && (
            <Button size="sm" onClick={() => setPanel(panel === "subscribe" ? null : "subscribe")} aria-expanded={panel === "subscribe"}>
              Subscribe
            </Button>
          )}
          {!own && (
            <Button size="sm" variant="ghost" className="border-rose-500/30 text-rose-200 hover:border-rose-400/60" onClick={() => onFileIncident(p)}>
              File incident
            </Button>
          )}
          {own && (
            <Button size="sm" variant="ghost" onClick={() => setPanel(panel === "capital" ? null : "capital")} aria-expanded={panel === "capital"}>
              Add capital
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onProbe(p)} title="Validators probe the endpoint and record the result on-chain (once per 5 min)">
            Record probe
          </Button>
        </div>
      </div>

      <div className="grid gap-5 border-t border-zinc-800/80 p-5 md:grid-cols-2">
        <UptimeBar p={p} />
        <LatencyMeter p={p} />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-zinc-800/80 p-5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Probe">
          <Mono>{method}</Mono>
        </Stat>
        <Stat label="Allowed downtime">
          <Mono>{formatDuration(p.max_downtime_s)}</Mono>
        </Stat>
        <Stat label="Premium">
          <Mono>{formatBps(p.premium_bps)} / 30d</Mono>
        </Stat>
        <Stat label="Free capital">
          <Mono>{formatGen(p.free_capital, 2)} GEN</Mono>
        </Stat>
        <Stat label="Incidents">
          <Mono>
            <span className="text-emerald-300">{p.incidents_confirmed}</span> / <span className="text-rose-300">{p.incidents_dismissed}</span>
          </Mono>
        </Stat>
        <Stat label="Underwriter">
          <Mono>{own ? "You" : shortAddr(p.owner)}</Mono>
        </Stat>
      </dl>

      <div className="px-5 pb-5">
        <div className="flex justify-between text-[11px] text-zinc-500">
          <span>Pool {formatGen(total, 2)} GEN</span>
          <span>{committedPct.toFixed(1)}% backing active policies</span>
        </div>
        <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div className="bg-sky-400/80" style={{ width: `${committedPct}%` }} />
          <div className="flex-1 bg-emerald-400/40" />
        </div>
      </div>

      {panel === "subscribe" && <Subscribe p={p} balance={balance} feeDeposit={feeDeposit} busy={busy} onBuy={onBuy} onDone={() => setPanel(null)} />}
      {panel === "capital" && <AddCapital p={p} balance={balance} feeDeposit={feeDeposit} busy={busy} onAdd={onAddCapital} onDone={() => setPanel(null)} />}
    </Card>
  );
}

function Breakdown({ rows, total, balance }: { rows: [string, bigint | null][]; total: bigint | null; balance: bigint | null }) {
  const short = total !== null && balance !== null && balance < total;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3 font-mono text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="flex justify-between py-0.5 text-zinc-400">
          <span>{k}</span>
          <span className="text-zinc-200">{v === null ? "…" : `${formatGen(v, 6)} GEN`}</span>
        </div>
      ))}
      <div className="mt-1.5 flex justify-between border-t border-zinc-800 pt-1.5 text-zinc-300">
        <span>Total from wallet</span>
        <span className="text-white">{total === null ? "…" : `${formatGen(total, 6)} GEN`}</span>
      </div>
      {balance !== null && (
        <div className={cx("mt-1 flex justify-between", short ? "text-rose-300" : "text-zinc-500")}>
          <span>{short ? "Insufficient balance" : "Wallet balance"}</span>
          <span>{formatGen(balance, 4)} GEN</span>
        </div>
      )}
    </div>
  );
}

function Subscribe({ p, balance, feeDeposit, busy, onBuy, onDone }: { p: Provider; balance: bigint | null; feeDeposit: bigint | null; busy: boolean; onBuy: Props["onBuy"]; onDone: () => void }) {
  const [coverage, setCoverage] = useState("5");
  const [term, setTerm] = useState(30);
  const [fetched, setFetched] = useState<{ key: string; quote: bigint | null } | null>(null);
  const amount = parseGen(coverage);
  const key = `${amount}:${term}`;

  let inputError: string | null = null;
  if (amount === null || amount <= 0n) inputError = "Enter a coverage amount.";
  else if (amount < 10n ** 18n) inputError = "Minimum coverage is 1 GEN.";
  else if (term < 1 || term > 90) inputError = "Terms run from 1 to 90 days.";
  else if (amount > p.free_capital) inputError = `This pool can underwrite up to ${formatGen(p.free_capital, 2)} GEN.`;

  useEffect(() => {
    if (inputError || amount === null) return;
    let live = true;
    const t = setTimeout(() => {
      views
        .quote(p.provider_id, amount, term)
        .then((q) => live && setFetched({ key, quote: q }))
        .catch(() => live && setFetched({ key, quote: null }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [inputError, amount, term, key, p.provider_id]);

  const quote = !inputError && fetched?.key === key ? fetched.quote : null;
  const total = quote !== null && feeDeposit !== null ? quote + feeDeposit : null;

  return (
    <form
      className="grid gap-4 border-t border-emerald-500/20 bg-emerald-500/[0.03] p-5 md:grid-cols-[1fr_1fr_1.2fr]"
      onSubmit={async (e) => {
        e.preventDefault();
        if (amount !== null && quote !== null && (await onBuy(p, amount, term, quote))) onDone();
      }}
    >
      <Field label="Coverage" hint="Paid in full on a confirmed breach">
        <GenInput value={coverage} onChange={(e) => setCoverage(e.target.value)} />
      </Field>
      <Field label="Term" hint="1–90 days">
        <div className="flex gap-1.5">
          {[7, 30, 90].map((d) => (
            <button type="button" key={d} onClick={() => setTerm(d)} className={cx("h-10 flex-1 rounded-xl border font-mono text-xs transition", term === d ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-200" : "border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:border-zinc-600")}>
              {d}d
            </button>
          ))}
        </div>
      </Field>
      <div className="flex flex-col gap-3">
        {inputError ? (
          <p className="text-xs text-amber-300">{inputError}</p>
        ) : (
          <Breakdown rows={[["Premium", quote], ["Consensus fee deposit", feeDeposit]]} total={total} balance={balance} />
        )}
        <Button disabled={busy || quote === null || (total !== null && balance !== null && balance < total)}>Buy coverage</Button>
      </div>
    </form>
  );
}

function AddCapital({ p, balance, feeDeposit, busy, onAdd, onDone }: { p: Provider; balance: bigint | null; feeDeposit: bigint | null; busy: boolean; onAdd: Props["onAddCapital"]; onDone: () => void }) {
  const [value, setValue] = useState("1");
  const amount = parseGen(value);
  const total = amount !== null && feeDeposit !== null ? amount + feeDeposit : null;
  return (
    <form
      className="grid gap-4 border-t border-sky-500/20 bg-sky-500/[0.03] p-5 md:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (amount && amount > 0n && (await onAdd(p, amount))) onDone();
      }}
    >
      <Field label="Deposit into this pool" hint="Raises free capital: more coverage can be sold and the slashing base grows">
        <GenInput value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className="flex flex-col gap-3">
        <Breakdown rows={[["Deposit", amount], ["Consensus fee deposit", feeDeposit]]} total={total} balance={balance} />
        <Button disabled={busy || !amount || amount <= 0n || (total !== null && balance !== null && balance < total)}>Add capital</Button>
      </div>
    </form>
  );
}

