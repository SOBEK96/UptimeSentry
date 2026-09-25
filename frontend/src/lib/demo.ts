// Guest mode: the console runs against sample telemetry and every contract
// action is simulated in the browser with the contract's own rules and error
// codes. Nothing is signed or sent to the network. It is entered on request
// ("Try as Studio guest") or automatically when the RPC can't be reached.
import { useSyncExternalStore } from "react";
import type { Claim, DrillResult, Policy, Provider } from "./types";
import type { Snapshot } from "./useSnapshot";
import { C, DEMO_ACCOUNT, gen, outcome, pid, sampleSnapshot, seqId, withDerived } from "./sample";
import { probeFromBrowser } from "./browserProbe";

export { DEMO_ACCOUNT };

export type DemoReason = "guest" | "rpc";

/** Stand-in for the consensus fee deposit the network quotes before a write. */
export const DEMO_FEE = gen(0.0025);

interface State {
  active: boolean;
  reason: DemoReason | null;
  snapshot: Snapshot;
  balance: bigint;
  claimable: bigint;
  writes: number;
}

const now = () => Math.floor(Date.now() / 1000);

const fresh = (): Omit<State, "active" | "reason"> => ({ snapshot: sampleSnapshot(), balance: gen(250), claimable: gen(1.5), writes: 0 });

let state: State = { active: false, reason: null, ...fresh() };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export const demo = {
  subscribe(l: () => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  get: () => state,
  enter(reason: DemoReason) {
    if (state.active && state.reason === "guest") return;
    set({ active: true, reason });
  },
  exit() {
    set({ active: false, reason: null });
  },
  reset() {
    set(fresh());
  },
  quote(providerId: string, coverage: bigint, termDays: number): bigint {
    const p = findProvider(state.snapshot, providerId);
    if (coverage < C.minCoverage) fail("ERR_COVERAGE_TOO_LOW");
    if (termDays < 1 || termDays > 90) fail("ERR_BAD_TERM");
    return (coverage * BigInt(p.premium_bps) * BigInt(termDays)) / (10_000n * 30n);
  },
  async drill(policyId: string, providerId: string, url: string, payload: string): Promise<DrillResult> {
    const s = state.snapshot;
    const p = findProvider(s, providerId);
    const pol = s.policies.find((x) => x.policy_id === policyId);
    const base: DrillResult = { bound: false, verdict: "REJECTED_UNBOUND_EVIDENCE", error: "", observed_up: false, code: "", required_reporter_bond: p.required_reporter_bond };
    if (url !== p.endpoint_url || payload !== p.probe_payload) return base;
    const probe = await validatorProbe(p);
    await pause(900);
    if (!pol || pol.status !== "ACTIVE" || pol.expires_at <= now()) return { ...base, bound: true, observed_up: probe.up, code: probe.code, verdict: "REJECTED_POLICY_NOT_ACTIVE" };
    return {
      ...base,
      bound: true,
      observed_up: probe.up,
      code: probe.code,
      verdict: probe.rateLimited ? "REJECTED_RATE_LIMITED" : probe.up ? "REJECTED_TARGET_HEALTHY" : "CLAIM_WOULD_BE_ACCEPTED",
      payout: pol.coverage,
      challenge_window_s: C.challengeWindow,
      confirm_after_s: p.max_downtime_s,
      observed_at: now(),
    };
  },
  /** Applies one contract write to the sample state. Throws the contract's
   * ERR_* codes so the UI explains a rejection exactly as it would live. */
  async write(account: string, fn: string, args: (string | number | bigint | boolean)[], value: bigint): Promise<string> {
    await pause(700);
    if (state.balance < value + DEMO_FEE) throw new Error("insufficient funds for value + fee");
    const t = now();
    const s: Snapshot = structuredClone(state.snapshot);
    let balance = state.balance - value - DEMO_FEE;
    let claimable = state.claimable;
    const me = account.toLowerCase();
    const credit = (who: string, amount: bigint) => {
      if (who.toLowerCase() === me) claimable += amount;
    };

    switch (fn) {
      case "purchase_coverage": {
        const [providerId, coverage, term] = [String(args[0]), BigInt(args[1]), Number(args[2])];
        const p = findProvider(s, providerId);
        if (value === 0n) fail("ERR_ZERO_VALUE");
        if (p.owner === me) fail("ERR_CONFLICTED_HOLDER");
        if (!p.accepting) fail("ERR_NOT_ACCEPTING");
        if (value !== demo.quote(providerId, coverage, term)) fail("ERR_PREMIUM_MISMATCH");
        if (coverage > p.free_capital) fail("ERR_INSUFFICIENT_UNDERWRITING");
        p.free_capital = p.free_capital - coverage + value;
        p.committed_capital += coverage;
        s.policies.push({ policy_id: seqId(s.policies.length + 1), provider_id: providerId, holder: me, coverage, premium: value, starts_at: t, expires_at: t + term * 86_400, status: "ACTIVE" });
        break;
      }
      case "attest_probe": {
        const p = findProvider(s, String(args[0]));
        if (p.last_probe_at && t < p.last_probe_at + C.probeCooldown) fail("ERR_PROBE_RATE_LIMITED");
        const probe = await validatorProbe(p);
        if (probe.rateLimited) fail("ERR_RATE_LIMITED");
        p.probes_total += 1;
        if (probe.up) p.probes_up += 1;
        p.observed_availability_bps = Math.floor((p.probes_up * 10_000) / p.probes_total);
        p.last_probe_at = t;
        p.last_probe_code = probe.code;
        break;
      }
      case "deposit_underwriting": {
        const p = findProvider(s, String(args[0]));
        if (value === 0n) fail("ERR_ZERO_VALUE");
        if (p.owner !== me) fail("ERR_NOT_PROVIDER_OWNER");
        p.free_capital += value;
        break;
      }
      case "register_provider": {
        const [name, url, kind, payload, maxDowntime, targetBps, premiumBps] = args;
        if (value < C.minUnderwriting) fail("ERR_UNDERWRITING_TOO_LOW");
        if (s.providers.some((p) => p.endpoint_url === url)) fail("ERR_PROVIDER_EXISTS");
        s.providers.push({
          provider_id: pid(s.providers.length + 1),
          owner: me,
          name: String(name),
          endpoint_url: String(url),
          probe_kind: kind === "HTTP_GET" ? "HTTP_GET" : "JSONRPC",
          probe_payload: String(payload),
          max_downtime_s: Number(maxDowntime),
          target_availability_bps: Number(targetBps),
          observed_availability_bps: -1,
          premium_bps: Number(premiumBps),
          accepting: true,
          free_capital: value,
          committed_capital: 0n,
          open_claims: 0,
          probes_total: 0,
          probes_up: 0,
          last_probe_at: 0,
          last_probe_code: "",
          incidents_confirmed: 0,
          incidents_dismissed: 0,
          total_slashed: 0n,
          total_paid_out: 0n,
          registered_at: t,
          required_reporter_bond: C.reporterBondBase,
        });
        break;
      }
      case "file_incident": {
        const [policyId, providerId, url, payload, trace] = args.map(String);
        const pol = findPolicy(s, policyId);
        const p = findProvider(s, providerId);
        if (value === 0n) fail("ERR_ZERO_BOND");
        if (p.owner === me) fail("ERR_CONFLICTED_REPORTER");
        if (pol.provider_id !== providerId || url !== p.endpoint_url || payload !== p.probe_payload) fail("ERR_UNBOUND_EVIDENCE");
        if (pol.status !== "ACTIVE") fail("ERR_POLICY_NOT_ACTIVE");
        if (pol.expires_at <= t) fail("ERR_POLICY_EXPIRED");
        if (value < p.required_reporter_bond) fail("ERR_BOND_TOO_LOW");
        const probe = await validatorProbe(p);
        if (probe.rateLimited) fail("ERR_RATE_LIMITED");
        if (probe.up) fail("ERR_NO_OUTAGE_OBSERVED");
        const triage = triageOf(trace);
        const confirmAfter = t + p.max_downtime_s;
        pol.status = "CLAIM_OPEN";
        s.claims.push({
          claim_id: seqId(s.claims.length + 1),
          policy_id: pol.policy_id,
          provider_id: p.provider_id,
          reporter: me,
          holder: pol.holder,
          payout: pol.coverage,
          reporter_bond: value,
          appellant: "",
          appeal_bond: 0n,
          required_appeal_bond: C.appealBondBase,
          status: "CLAIM_PENDING",
          filed_at: t,
          challenge_deadline: t + C.challengeWindow,
          confirm_after: confirmAfter,
          confirmation_closes: confirmAfter + C.resolutionWindow,
          resolved_at: 0,
          filing_probe_code: probe.code,
          ruling_probe_code: "",
          failure_trace: trace,
          evidence_hash: await sha256(`${p.endpoint_url}|${p.probe_payload}|${probe.code}|${trace}`),
          slash_amount: 0n,
          samples_total: 0,
          samples_down: 0,
          last_sample_at: 0,
          ...triage,
        });
        break;
      }
      case "file_appeal": {
        const c = findClaim(s, String(args[0]));
        if (c.status === "UNDER_APPEAL") fail("ERR_ALREADY_UNDER_APPEAL");
        if (c.status !== "CLAIM_PENDING") fail("ERR_NOT_APPEALABLE");
        if (c.reporter === me || c.holder === me) fail("ERR_CONFLICTED_APPELLANT");
        if (t >= c.challenge_deadline) fail("ERR_CHALLENGE_WINDOW_CLOSED");
        if (value < c.required_appeal_bond) fail("ERR_BOND_TOO_LOW");
        c.status = "UNDER_APPEAL";
        c.appellant = me;
        c.appeal_bond = value;
        break;
      }
      case "confirm_outage": {
        const c = findClaim(s, String(args[0]));
        const p = findProvider(s, c.provider_id);
        if (c.status !== "CLAIM_PENDING" && c.status !== "UNDER_APPEAL") fail("ERR_CLAIM_NOT_OPEN");
        if (t < c.confirm_after) fail("ERR_CONFIRMATION_NOT_OPEN");
        if (t > c.confirm_after + C.resolutionWindow) fail("ERR_CONFIRMATION_CLOSED");
        if (c.last_sample_at && t < c.last_sample_at + C.sampleInterval) fail("ERR_SAMPLE_TOO_SOON");
        const probe = await validatorProbe(p);
        if (probe.rateLimited) fail("ERR_RATE_LIMITED");
        c.samples_total = (c.samples_total ?? 0) + 1;
        if (!probe.up) c.samples_down = (c.samples_down ?? 0) + 1;
        c.last_sample_at = t;
        break;
      }
      case "resolve_appeal": {
        const c = findClaim(s, String(args[0]));
        const p = findProvider(s, c.provider_id);
        if (c.status !== "UNDER_APPEAL") fail("ERR_NOT_UNDER_APPEAL");
        const o = outcome(c, t);
        if (o === "PENDING") fail("ERR_ADJUDICATION_NOT_READY");
        c.ruling_probe_code = o !== "SUSTAINED" ? "UP" : p.last_probe_code && p.last_probe_code !== "UP" ? p.last_probe_code : c.filing_probe_code;
        if (o === "INSUFFICIENT") {
          closeInsufficient(s, c, t, credit);
          credit(c.appellant, c.appeal_bond);
        } else if (o === "SUSTAINED") {
          const slash = min(p.free_capital, (c.payout * BigInt(C.slashBps)) / 10_000n);
          const share = (slash * BigInt(C.reporterSlashShareBps)) / 10_000n;
          p.free_capital -= slash;
          p.total_slashed += slash;
          p.incidents_confirmed += 1;
          c.slash_amount = slash;
          c.resolved_at = t;
          c.status = "CONFIRMED";
          credit(c.reporter, c.reporter_bond + share);
          credit(c.holder, slash - share + c.appeal_bond);
        } else {
          dismiss(s, c, t);
          c.status = "DISMISSED";
          credit(c.appellant, c.appeal_bond);
        }
        break;
      }
      case "claim_payout": {
        const c = findClaim(s, String(args[0]));
        const p = findProvider(s, c.provider_id);
        if (c.status === "UNDER_APPEAL") fail("ERR_PAYOUT_LOCKED");
        if (c.status === "DISMISSED" || c.status === "RECOVERED" || c.status === "INDETERMINATE_INSUFFICIENT_SAMPLES") fail("ERR_CLAIM_DISMISSED");
        if (c.status === "PAID") fail("ERR_ALREADY_SETTLED");
        if (c.status === "CLAIM_PENDING") {
          if (t < c.challenge_deadline) fail("ERR_CHALLENGE_WINDOW_OPEN");
          const o = outcome(c, t);
          if (o === "PENDING") fail("ERR_OUTAGE_UNCONFIRMED");
          if (o === "INSUFFICIENT") {
            closeInsufficient(s, c, t, credit);
            break;
          }
          if (o === "RECOVERED") {
            dismiss(s, c, t);
            c.status = "RECOVERED";
            break;
          }
          p.incidents_confirmed += 1;
          credit(c.reporter, c.reporter_bond);
          c.resolved_at = t;
        }
        c.status = "PAID";
        findPolicy(s, c.policy_id).status = "CLAIMED";
        p.committed_capital = p.committed_capital > c.payout ? p.committed_capital - c.payout : 0n;
        p.total_paid_out += c.payout;
        if (c.holder === me) balance += c.payout;
        break;
      }
      case "withdraw": {
        if (claimable === 0n) fail("ERR_NOTHING_TO_WITHDRAW");
        balance += claimable;
        claimable = 0n;
        break;
      }
      default:
        fail("ERR_UNSUPPORTED_IN_GUEST_MODE");
    }

    set({ snapshot: withDerived(s, t), balance, claimable, writes: state.writes + 1 });
    return `0x${(await sha256(`${fn}|${t}|${state.writes}`)).slice(0, 64)}`;
  },
};

export function useDemo() {
  return useSyncExternalStore(demo.subscribe, demo.get);
}

// ---- helpers ---------------------------------------------------------------

function fail(code: string): never {
  throw new Error(code);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const min = (a: bigint, b: bigint) => (a < b ? a : b);

function findProvider(s: Snapshot, id: string): Provider {
  return s.providers.find((p) => p.provider_id === id) ?? fail("ERR_UNKNOWN_PROVIDER");
}
function findPolicy(s: Snapshot, id: string): Policy {
  return s.policies.find((p) => p.policy_id === id) ?? fail("ERR_UNKNOWN_POLICY");
}
function findClaim(s: Snapshot, id: string): Claim {
  return s.claims.find((c) => c.claim_id === id) ?? fail("ERR_UNKNOWN_CLAIM");
}

function releaseBacking(s: Snapshot, c: Claim, t: number) {
  const pol = findPolicy(s, c.policy_id);
  pol.status = t < pol.expires_at ? "ACTIVE" : "RELEASED";
}

function dismiss(s: Snapshot, c: Claim, t: number) {
  const p = findProvider(s, c.provider_id);
  p.free_capital += c.reporter_bond;
  p.incidents_dismissed += 1;
  releaseBacking(s, c, t);
  c.resolved_at = t;
}

function closeInsufficient(s: Snapshot, c: Claim, t: number, credit: (who: string, amount: bigint) => void) {
  credit(c.reporter, c.reporter_bond);
  releaseBacking(s, c, t);
  c.resolved_at = t;
  c.status = "INDETERMINATE_INSUFFICIENT_SAMPLES";
}

/** What validators would observe. Endpoints the sample data marks as failing
 * stay down so the claim lifecycle can be explored; every other endpoint is
 * probed for real from this browser, and treated as up when the browser can't
 * read the response (CORS), since validators probe server-side. */
async function validatorProbe(p: Provider): Promise<{ up: boolean; code: string; rateLimited: boolean }> {
  if (p.last_probe_code && p.last_probe_code !== "UP") return { up: false, code: p.last_probe_code, rateLimited: false };
  const r = await probeFromBrowser(p.endpoint_url, p.probe_kind, p.probe_payload);
  if (r.state !== "ok") return { up: true, code: "UP", rateLimited: false };
  if (r.status === 429 || r.status === 403) return { up: false, code: `HTTP_${r.status}`, rateLimited: true };
  return r.healthy ? { up: true, code: "UP", rateLimited: false } : { up: false, code: r.status >= 400 ? `HTTP_${r.status}` : "BAD_RESPONSE", rateLimited: false };
}

// Stand-in for the contract's advisory LLM triage of the reporter's trace.
function triageOf(trace: string): Pick<Claim, "triage_verdict" | "triage_notes"> {
  if (/\b5\d\d\b|bad gateway|unavailable|refused|reset|stall|unhealthy|dns|nxdomain|all regions|\d+ regions/i.test(trace))
    return {
      triage_verdict: "ADVISORY_INFRASTRUCTURE_OUTAGE",
      triage_notes: "The trace describes server-side failures (5xx, resets or a self-reported unhealthy node), which point at the provider rather than the reporter's network. This is advisory; payout still depends on confirmation samples.",
    };
  if (/\b4\d\d\b|wifi|laptop|my (network|machine)|vpn|cors|local/i.test(trace))
    return {
      triage_verdict: "ADVISORY_CLIENT_ARTIFACT",
      triage_notes: "The trace reads like a client-side problem (4xx, local network or CORS). It is advisory only: validators' confirmation samples decide the claim.",
    };
  return {
    triage_verdict: "ADVISORY_INCONCLUSIVE",
    triage_notes: "The trace doesn't clearly separate a provider outage from a client-side issue, so the triage abstains. The confirmation samples decide.",
  };
}

async function sha256(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  }
}
