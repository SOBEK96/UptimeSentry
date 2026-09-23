import { useMemo, useState } from "react";
import type { Claim, Policy, Provider } from "../lib/types";
import { formatGen, sameAddr, shortAddr } from "../lib/format";
import { EscrowTimeline } from "./EscrowTimeline";
import { Badge, Button, Card, Empty, Field, Mono, Stat } from "./ui";
import { inputClass, cx, type Tone } from "./styles";

const STATUS: Record<Claim["status"], { label: string; tone: Tone }> = {
  CLAIM_PENDING: { label: "Challenge window", tone: "amber" },
  UNDER_APPEAL: { label: "Under appeal · escrow locked", tone: "sky" },
  CONFIRMED: { label: "Breach confirmed", tone: "emerald" },
  DISMISSED: { label: "Dismissed", tone: "rose" },
  RECOVERED: { label: "Recovered · no breach", tone: "rose" },
  INDETERMINATE_INSUFFICIENT_SAMPLES: { label: "Indeterminate · bonds refunded", tone: "zinc" },
  PAID: { label: "Paid out", tone: "emerald" },
};

interface Props {
  claims: Claim[];
  policies: Policy[];
  providers: Provider[];
  account: string | null;
  now: number;
  busy: boolean;
  focusProvider: string | null;
  onReport: (policy: Policy, provider: Provider, trace: string, bond: bigint) => void;
  onAppeal: (c: Claim) => void;
  onResolve: (c: Claim) => void;
  onConfirm: (c: Claim) => void;
  onPayout: (c: Claim) => void;
}

export function Incidents(props: Props) {
  const byId = useMemo(() => new Map(props.providers.map((p) => [p.provider_id, p])), [props.providers]);
  const ordered = [...props.claims].reverse();
  return (
    <div className="grid gap-6">
      <ReportForm {...props} />
      <section aria-labelledby="claims-h" className="grid gap-4">
        <h2 id="claims-h" className="text-sm font-semibold uppercase tracking-wider text-zinc-400">
          Claims
        </h2>
        {ordered.length === 0 ? <Empty title="No incidents have been reported." /> : ordered.map((c) => <ClaimCard key={c.claim_id} {...props} c={c} p={byId.get(c.provider_id)} />)}
      </section>
    </div>
  );
}

function ReportForm({ policies, providers, now, busy, account, focusProvider, onReport }: Props) {
  const reportable = policies.filter((p) => p.status === "ACTIVE" && p.expires_at > now && (!focusProvider || p.provider_id === focusProvider));
  const [policyId, setPolicyId] = useState("");
  const [trace, setTrace] = useState("");
  const policy = reportable.find((p) => p.policy_id === policyId) ?? reportable[0];
  const provider = policy ? providers.find((p) => p.provider_id === policy.provider_id) : undefined;
  const focused = focusProvider ? providers.find((p) => p.provider_id === focusProvider) : undefined;
  const own = provider && sameAddr(account, provider.owner);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-white">Report an outage</h2>
        {focused && <Badge tone="rose">{focused.name}</Badge>}
      </div>
      <p className="mt-1 max-w-2xl text-sm text-zinc-400">
        Validators probe the registered endpoint when you file. If they find it healthy, the transaction reverts and no claim opens. An accepted report escrows the payout for a 24-hour challenge window.
      </p>
      {reportable.length === 0 ? (
        <p className="mt-4 rounded-xl border border-zinc-800 bg-zinc-950/50 p-4 text-sm text-zinc-400">
          {focused ? `${focused.name} has no active policies yet. A report needs a policy to pay out against. Subscribe to it first.` : "There are no active policies to report against."}
        </p>
      ) : (
        <form
          className="mt-5 grid gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (policy && provider) onReport(policy, provider, trace, provider.required_reporter_bond);
          }}
        >
          <Field label="Policy">
            <select className={inputClass} value={policy?.policy_id} onChange={(e) => setPolicyId(e.target.value)}>
              {reportable.map((p) => (
                <option key={p.policy_id} value={p.policy_id}>
                  {providers.find((x) => x.provider_id === p.provider_id)?.name ?? p.provider_id} · {formatGen(p.coverage, 2)} GEN · {shortAddr(p.holder)}
                </option>
              ))}
            </select>
          </Field>
          {provider && (
            <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 font-mono text-xs">
              <span className="text-[10px] uppercase tracking-wider text-zinc-500">Bound evidence target</span>
              <span className="break-all text-zinc-200">{provider.endpoint_url}</span>
              {provider.probe_payload && <span className="break-all text-zinc-500">{provider.probe_payload}</span>}
            </div>
          )}
          <Field label="Failure trace" className="md:col-span-2">
            <textarea required maxLength={2000} rows={3} className={cx(inputClass, "h-auto py-2 font-mono text-xs")} placeholder="POST eth_blockNumber → HTTP 503 from 3 regions, 14:02–14:09 UTC" value={trace} onChange={(e) => setTrace(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3 md:col-span-2">
            <span className="text-sm text-zinc-400">
              Reporter bond <Mono className="text-white">{provider ? formatGen(provider.required_reporter_bond) : "…"} GEN</Mono>
              <span className="text-zinc-500"> · doubles with each open claim on this endpoint</span>
            </span>
            <Button variant="danger" disabled={busy || !provider || !trace.trim() || !!own}>
              {own ? "You underwrite this endpoint" : "File incident"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

function ClaimCard({ c, p, now, account, busy, onAppeal, onResolve, onPayout, onConfirm }: Props & { c: Claim; p?: Provider }) {
  const closes = c.confirmation_closes ?? c.confirm_after;
  const open = c.status === "CLAIM_PENDING" || c.status === "UNDER_APPEAL";
  const canAppeal = c.status === "CLAIM_PENDING" && now < c.challenge_deadline && !sameAddr(account, c.reporter) && !sameAddr(account, c.holder);
  const canSample = open && now >= c.confirm_after && now <= closes && (!c.last_sample_at || now >= c.last_sample_at + 600);
  const canResolve = c.status === "UNDER_APPEAL" && now > closes;
  const canPay = (c.status === "CLAIM_PENDING" && now >= c.challenge_deadline && now > closes) || c.status === "CONFIRMED";
  const willRecover = c.status === "CLAIM_PENDING" && (c.outcome === "RECOVERED" || c.outcome === "INSUFFICIENT");
  const you = (a: string) => (sameAddr(account, a) ? "You" : shortAddr(a));
  const s = STATUS[c.status];
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white">
            {p?.name ?? "Endpoint"} <Mono className="text-zinc-500">#{parseInt(c.claim_id, 16)}</Mono>
          </h3>
          <Mono className="block break-all text-xs text-zinc-400">{p?.endpoint_url}</Mono>
        </div>
        <Badge tone={s.tone} dot pulse={c.status === "CLAIM_PENDING" || c.status === "UNDER_APPEAL"}>
          {s.label}
        </Badge>
      </div>

      <div className="mt-6">
        <EscrowTimeline claim={c} now={now} />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-zinc-800/80 pt-4 sm:grid-cols-4">
        <Stat label="Escrowed payout">
          <Mono>{formatGen(c.payout)} GEN</Mono>
        </Stat>
        <Stat label="Insured">
          <Mono>{you(c.holder)}</Mono>
        </Stat>
        <Stat label="Reporter · bond">
          <Mono>
            {you(c.reporter)} · {formatGen(c.reporter_bond)}
          </Mono>
        </Stat>
        <Stat label="Filing probe">
          <Mono className="text-rose-300">{c.filing_probe_code}</Mono>
        </Stat>
        {c.samples_total !== undefined && (
          <Stat label="Confirmation samples">
            <Mono>{c.samples_down}/{c.samples_total} DOWN</Mono>
          </Stat>
        )}
        {c.triage_verdict && (
          <Stat label="LLM triage">
            <Mono className={c.triage_verdict === "ADVISORY_INFRASTRUCTURE_OUTAGE" ? "text-emerald-300" : "text-amber-300"}>{c.triage_verdict.replace(/^ADVISORY_/, "").replace(/_/g, " ").toLowerCase()} (advisory)</Mono>
          </Stat>
        )}
        {c.appellant && (
          <Stat label="Appellant · bond">
            <Mono>
              {you(c.appellant)} · {formatGen(c.appeal_bond)}
            </Mono>
          </Stat>
        )}
        {c.ruling_probe_code && (
          <Stat label="Ruling probe">
            <Mono className={c.ruling_probe_code === "UP" ? "text-emerald-300" : "text-rose-300"}>{c.ruling_probe_code}</Mono>
          </Stat>
        )}
        {c.slash_amount > 0n && (
          <Stat label="Provider slashed">
            <Mono>{formatGen(c.slash_amount)} GEN</Mono>
          </Stat>
        )}
      </dl>

      <details className="group mt-4 text-sm">
        <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">Reported trace and evidence hash</summary>
        <pre className="mt-2 whitespace-pre-wrap rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 font-mono text-xs text-zinc-300">{c.failure_trace}</pre>
        {c.triage_notes && <p className="mt-2 text-xs text-zinc-400">Advisory triage: {c.triage_notes}</p>}
        <Mono className="mt-2 block break-all text-xs text-zinc-500">sha256:{c.evidence_hash}</Mono>
      </details>

      {(canAppeal || canSample || canResolve || canPay) && (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {canSample && (
            <Button variant="ghost" disabled={busy} onClick={() => onConfirm(c)} title="Validators probe the endpoint; payout needs a DOWN majority of these samples">
              Record confirmation sample
            </Button>
          )}
          {canAppeal && (
            <Button variant="ghost" disabled={busy} onClick={() => onAppeal(c)}>
              Appeal · {formatGen(c.required_appeal_bond)} GEN bond
            </Button>
          )}
          {canResolve && (
            <Button disabled={busy} onClick={() => onResolve(c)}>
              Rule on appeal
            </Button>
          )}
          {canPay && (
            <Button variant={willRecover ? "ghost" : "success"} disabled={busy} onClick={() => onPayout(c)}>
              {willRecover ? "Settle claim (no breach proven)" : `Release ${formatGen(c.payout)} GEN to insured`}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
