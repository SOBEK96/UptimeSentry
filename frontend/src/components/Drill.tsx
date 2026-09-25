import { useEffect, useRef, useState } from "react";
import type { DrillResult, Policy, Provider } from "../lib/types";
import { views } from "../lib/contract";
import { demo } from "../lib/demo";
import { explainError } from "../lib/errors";
import { probeFromBrowser } from "../lib/browserProbe";
import { formatDuration, formatGen, shortAddr } from "../lib/format";
import { Badge, Button, Card, Empty, Field } from "./ui";
import { inputClass, cx } from "./styles";

type Line = { t: string; kind: "cmd" | "info" | "ok" | "warn" | "err" | "note"; text: string };

const COLORS: Record<Line["kind"], string> = {
  cmd: "text-white",
  info: "text-zinc-400",
  ok: "text-emerald-300",
  warn: "text-amber-300",
  err: "text-rose-300",
  note: "text-zinc-600",
};

const VERDICT: Record<DrillResult["verdict"], { kind: Line["kind"]; text: string }> = {
  CLAIM_WOULD_BE_ACCEPTED: { kind: "err", text: "CLAIM_WOULD_BE_ACCEPTED: target is failing; a report filed now escrows the payout" },
  REJECTED_TARGET_HEALTHY: { kind: "ok", text: "REJECTED_TARGET_HEALTHY: target answered correctly; a report filed now reverts" },
  REJECTED_POLICY_NOT_ACTIVE: { kind: "warn", text: "REJECTED_POLICY_NOT_ACTIVE: policy expired, paid, or already has an open claim" },
  REJECTED_UNBOUND_EVIDENCE: { kind: "err", text: "REJECTED_UNBOUND_EVIDENCE: target differs from the registered endpoint/payload" },
  REJECTED_RATE_LIMITED: { kind: "warn", text: "REJECTED_RATE_LIMITED: the endpoint answered 429/403; rate limits are not evidence of an outage" },
};

const stamp = () => new Date().toISOString().slice(11, 19);

export function Drill({ policies, providers, onExplore }: { policies: Policy[]; providers: Provider[]; onExplore?: () => void }) {
  const [providerId, setProviderId] = useState(providers[0]?.provider_id ?? "");
  const provider = providers.find((p) => p.provider_id === providerId) ?? providers[0];
  if (!provider)
    return (
      <Empty title="Register an endpoint to run diagnostics against it.">
        {onExplore && (
          <Button variant="ghost" onClick={onExplore}>
            Try the drill on sample endpoints
          </Button>
        )}
      </Empty>
    );
  return <DrillConsole key={provider.provider_id} provider={provider} providers={providers} policies={policies.filter((p) => p.provider_id === provider.provider_id)} onProvider={setProviderId} />;
}

function DrillConsole({ provider, providers, policies, onProvider }: { provider: Provider; providers: Provider[]; policies: Policy[]; onProvider: (id: string) => void }) {
  const [policyId, setPolicyId] = useState((policies.find((p) => p.status === "ACTIVE") ?? policies[0])?.policy_id ?? "");
  const [url, setUrl] = useState(provider.endpoint_url);
  const [payload, setPayload] = useState(provider.probe_payload);
  const [lines, setLines] = useState<Line[]>([{ t: stamp(), kind: "note", text: "# ready. choose a check below." }]);
  const [running, setRunning] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const bound = url === provider.endpoint_url && payload === provider.probe_payload;

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const log = (kind: Line["kind"], text: string) => setLines((l) => [...l, { t: stamp(), kind, text }]);

  const browserProbe = async () => {
    setRunning(true);
    log("cmd", `$ probe --from browser ${url}`);
    log("info", `→ ${provider.probe_kind === "JSONRPC" ? `POST ${payload}` : "GET"}`);
    const r = await probeFromBrowser(url, provider.probe_kind, payload);
    if (r.state === "ok") log(r.healthy ? "ok" : "err", `← HTTP ${r.status} in ${r.ms} ms · ${r.healthy ? "healthy" : "unhealthy response"}`);
    else log("warn", "← no response readable from this browser (CORS, TLS or timeout)");
    log("note", "# measured from your machine; validators probe independently when a claim is filed");
    setRunning(false);
  };

  const chainDrill = async () => {
    const policy = policies.find((p) => p.policy_id === policyId);
    if (!policy) return;
    setRunning(true);
    log("cmd", `$ run_sla_drill --policy ${policy.policy_id} --target ${url}`);
    log(bound ? "ok" : "warn", bound ? "✓ binding: endpoint and payload match the registered target" : "! binding: target differs from registration; expect rejection");
    log(
      "info",
      demo.get().active
        ? "… guest mode: evaluating in your browser with the contract's rules (sample telemetry), nothing is committed"
        : "… simulating on a GenLayer node: the probe runs inside GenVM, nothing is committed",
    );
    try {
      const r = await views.drill(policy.policy_id, provider.provider_id, url, payload);
      if (r.bound) log(r.observed_up ? "ok" : "err", `← GenVM probe response: ${r.code}`);
      // Simulation runs on a fixed node clock, so policy expiry is re-checked
      // against real time here.
      const expired = policy.expires_at <= Math.floor(Date.now() / 1000);
      if (expired && r.bound && r.verdict !== "REJECTED_POLICY_NOT_ACTIVE") r.verdict = "REJECTED_POLICY_NOT_ACTIVE";
      const v = VERDICT[r.verdict];
      log(v.kind, `⇒ ${v.text}`);
      if (r.bound) {
        log("info", `  reporter bond ${formatGen(r.required_reporter_bond)} GEN · payout ${formatGen(r.payout ?? 0n)} GEN · must persist ${formatDuration(r.confirm_after_s ?? 0)}`);
      }
      log("note", "# a simulation runs on one node and changes nothing. file_incident repeats this probe under full validator consensus.");
    } catch (e) {
      log("err", `✗ ${explainError(e)}`);
    }
    setRunning(false);
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Card className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="text-base font-semibold text-white">SLA diagnostic drill</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Dry-run an incident against live telemetry. Nothing is written: no pool, escrow, bond or counter changes. Edit the target to see how unbound evidence is rejected.
          </p>
        </div>
        <Field label="Endpoint">
          <select className={inputClass} value={provider.provider_id} onChange={(e) => onProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.provider_id} value={p.provider_id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target URL" hint={bound ? "Matches the registered endpoint" : "Differs from the registered endpoint"}>
          <input className={cx(inputClass, "font-mono text-xs", !bound && "border-amber-500/50")} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Probe payload">
          <input className={cx(inputClass, "font-mono text-xs")} value={payload} onChange={(e) => setPayload(e.target.value)} spellCheck={false} placeholder="(empty for HTTP GET)" />
        </Field>
        <Field label="Policy for on-chain drill" hint={policies.length === 0 ? "The contract drills against a policy. Subscribe to this endpoint to enable it." : undefined}>
          <select className={inputClass} value={policyId} onChange={(e) => setPolicyId(e.target.value)} disabled={policies.length === 0}>
            {policies.length === 0 && <option>No policies on this endpoint</option>}
            {policies.map((p) => (
              <option key={p.policy_id} value={p.policy_id}>
                #{parseInt(p.policy_id, 16)} · {p.status.toLowerCase()} · {shortAddr(p.holder)}
              </option>
            ))}
          </select>
        </Field>
        <div className="mt-auto flex flex-wrap gap-2">
          <Button variant="ghost" onClick={browserProbe} disabled={running}>
            Probe from browser
          </Button>
          <Button onClick={chainDrill} disabled={running || policies.length === 0}>
            Run on-chain drill
          </Button>
        </div>
      </Card>

      <Card className="flex min-h-[420px] flex-col overflow-hidden bg-zinc-950/80">
        <div className="flex items-center justify-between border-b border-zinc-800/80 px-4 py-2.5">
          <div className="flex gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-rose-400/70" />
            <span className="size-2.5 rounded-full bg-amber-400/70" />
            <span className="size-2.5 rounded-full bg-emerald-400/70" />
          </div>
          <span className="font-mono text-[11px] text-zinc-500">uptimesentry://drill</span>
          <div className="flex items-center gap-2">
            {running && <Badge tone="amber" dot pulse>running</Badge>}
            <button className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300" onClick={() => setLines([])}>
              clear
            </button>
          </div>
        </div>
        <div ref={scroller} className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed" role="log" aria-live="polite">
          {lines.map((l, i) => (
            <div key={i} className="flex gap-3">
              <span className="shrink-0 text-zinc-700">{l.t}</span>
              <span className={cx("break-all", COLORS[l.kind])}>{l.text}</span>
            </div>
          ))}
          <span className="animate-caret inline-block h-3.5 w-1.5 translate-y-0.5 bg-emerald-400/80" />
        </div>
      </Card>
    </div>
  );
}
