// Sample telemetry for guest mode and for when the RPC can't be reached. The
// shapes, constants and state machine mirror contracts/uptimesentry.py so every
// view renders exactly as it does against the live contract.
import type { Claim, Policy, ProtocolStats, Provider } from "./types";
import type { Snapshot } from "./useSnapshot";

export const DEMO_ACCOUNT = "0x5eed00000000000000000000000000000000de30" as const;

export const ATTO = 10n ** 18n;
export const gen = (n: number) => (BigInt(Math.round(n * 1e6)) * ATTO) / 1_000_000n;

// Contract constants (see uptimesentry.py).
export const C = {
  challengeWindow: 86_400,
  resolutionWindow: 7_200,
  sampleInterval: 600,
  probeCooldown: 300,
  minSamples: 3,
  slashBps: 2_000,
  reporterSlashShareBps: 5_000,
  appealBondBps: 1_000,
  reporterBondBase: gen(1),
  appealBondBase: gen(2),
  minUnderwriting: gen(10),
  minCoverage: gen(1),
} as const;

const HOUR = 3_600;
const DAY = 86_400;

const addr = (seed: string) => `0x${seed.padEnd(40, "0").slice(0, 40)}`;
export const pid = (n: number) => `0x${n.toString(16).padStart(2, "0")}${"5a3e1c9b7d".repeat(4)}`.slice(0, 42);
export const seqId = (n: number) => `0x${n.toString(16).padStart(16, "0")}`;
const hash = (n: number) => Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(n * 7 + i * 13 + ((i * n) % 5)) % 16]).join("");

const rpc = (method: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] });

function provider(p: Partial<Provider> & Pick<Provider, "provider_id" | "name" | "endpoint_url">): Provider {
  return {
    owner: addr("7a3cf1"),
    probe_kind: "JSONRPC",
    probe_payload: rpc("eth_blockNumber"),
    max_downtime_s: 600,
    target_availability_bps: 9_990,
    observed_availability_bps: 10_000,
    premium_bps: 200,
    accepting: true,
    free_capital: gen(20),
    committed_capital: 0n,
    open_claims: 0,
    probes_total: 0,
    probes_up: 0,
    last_probe_at: 0,
    last_probe_code: "UP",
    incidents_confirmed: 0,
    incidents_dismissed: 0,
    total_slashed: 0n,
    total_paid_out: 0n,
    registered_at: 0,
    required_reporter_bond: C.reporterBondBase,
    ...p,
  };
}

export function sampleSnapshot(now = Math.floor(Date.now() / 1000)): Snapshot {
  const t = now;
  const [eth, base, sol, arb] = [pid(1), pid(2), pid(3), pid(4)];

  const providers: Provider[] = [
    provider({
      provider_id: eth,
      name: "Ethereum Mainnet · PublicNode",
      endpoint_url: "https://ethereum-rpc.publicnode.com",
      owner: addr("7a3cf1e2"),
      max_downtime_s: 600,
      target_availability_bps: 9_990,
      observed_availability_bps: 9_995,
      premium_bps: 200,
      free_capital: gen(41.2),
      committed_capital: gen(17),
      open_claims: 1,
      probes_total: 412,
      probes_up: 410,
      last_probe_at: t - 7 * 60,
      incidents_confirmed: 1,
      total_slashed: gen(1),
      total_paid_out: gen(5),
      registered_at: t - 21 * DAY,
    }),
    provider({
      provider_id: base,
      name: "Base Mainnet Public RPC",
      endpoint_url: "https://mainnet.base.org",
      owner: addr("b45e0c07"),
      probe_payload: rpc("eth_chainId"),
      max_downtime_s: 1_800,
      target_availability_bps: 9_950,
      observed_availability_bps: 9_962,
      premium_bps: 150,
      free_capital: gen(55.5),
      committed_capital: gen(20),
      open_claims: 1,
      probes_total: 266,
      probes_up: 265,
      last_probe_at: t - 22 * 60,
      incidents_dismissed: 2,
      registered_at: t - 18 * DAY,
    }),
    provider({
      provider_id: sol,
      name: "Solana Mainnet Beta RPC",
      endpoint_url: "https://api.mainnet-beta.solana.com",
      owner: addr("501a4a11"),
      probe_payload: rpc("getHealth"),
      max_downtime_s: 300,
      target_availability_bps: 9_900,
      observed_availability_bps: 9_821,
      premium_bps: 350,
      free_capital: gen(21.4),
      committed_capital: gen(23),
      open_claims: 2,
      probes_total: 168,
      probes_up: 165,
      last_probe_at: t - 4 * 60,
      last_probe_code: "HTTP_503",
      incidents_dismissed: 1,
      registered_at: t - 12 * DAY,
    }),
    provider({
      provider_id: arb,
      name: "Arbitrum One Public RPC",
      endpoint_url: "https://arb1.arbitrum.io/rpc",
      owner: DEMO_ACCOUNT,
      probe_payload: rpc("eth_chainId"),
      max_downtime_s: 900,
      target_availability_bps: 9_990,
      observed_availability_bps: 10_000,
      premium_bps: 180,
      free_capital: gen(15),
      committed_capital: gen(5),
      probes_total: 36,
      probes_up: 36,
      last_probe_at: t - 41 * 60,
      registered_at: t - 3 * DAY,
    }),
  ];

  const pol = (n: number, provider_id: string, holder: string, coverage: number, startedAgo: number, termDays: number, status: Policy["status"]): Policy => {
    const p = providers.find((x) => x.provider_id === provider_id)!;
    return {
      policy_id: seqId(n),
      provider_id,
      holder,
      coverage: gen(coverage),
      premium: (gen(coverage) * BigInt(p.premium_bps) * BigInt(termDays)) / (10_000n * 30n),
      starts_at: t - startedAgo,
      expires_at: t - startedAgo + termDays * DAY,
      status,
    };
  };

  const policies: Policy[] = [
    pol(1, eth, addr("a21f33"), 5, 16 * DAY, 30, "CLAIMED"),
    pol(2, base, addr("f3c002"), 4, 40 * DAY, 30, "RELEASED"),
    pol(3, sol, addr("91be70"), 3, 11 * DAY, 30, "ACTIVE"),
    pol(4, base, addr("c9d4a1"), 8, 9 * DAY, 30, "CLAIM_OPEN"),
    pol(5, eth, DEMO_ACCOUNT, 10, 2 * DAY, 30, "ACTIVE"),
    pol(6, eth, addr("b4e8f0"), 2, 5 * DAY, 30, "CLAIM_OPEN"),
    pol(7, base, addr("d1a577"), 12, 4 * DAY, 90, "ACTIVE"),
    pol(8, sol, DEMO_ACCOUNT, 6, 1 * DAY, 30, "CLAIM_OPEN"),
    pol(9, sol, addr("e7f001"), 10, 6 * DAY, 30, "CLAIM_OPEN"),
    pol(10, sol, DEMO_ACCOUNT, 4, 3 * HOUR, 7, "ACTIVE"),
    pol(11, arb, addr("6b0a12"), 5, 2 * DAY, 30, "ACTIVE"),
    pol(12, eth, addr("2c77d9"), 5, 8 * DAY, 30, "ACTIVE"),
  ];

  const claim = (
    n: number,
    policyN: number,
    filedAgo: number,
    c: Partial<Claim> & Pick<Claim, "status" | "reporter" | "filing_probe_code" | "failure_trace">,
  ): Claim => {
    const policy = policies[policyN - 1];
    const p = providers.find((x) => x.provider_id === policy.provider_id)!;
    const filed = t - filedAgo;
    const confirmAfter = filed + p.max_downtime_s;
    return {
      claim_id: seqId(n),
      policy_id: policy.policy_id,
      provider_id: p.provider_id,
      holder: policy.holder,
      payout: policy.coverage,
      reporter_bond: C.reporterBondBase,
      appellant: "",
      appeal_bond: 0n,
      required_appeal_bond: C.appealBondBase,
      filed_at: filed,
      challenge_deadline: filed + C.challengeWindow,
      confirm_after: confirmAfter,
      confirmation_closes: confirmAfter + C.resolutionWindow,
      resolved_at: 0,
      ruling_probe_code: "",
      evidence_hash: hash(n),
      slash_amount: 0n,
      samples_total: 0,
      samples_down: 0,
      last_sample_at: 0,
      triage_verdict: "ADVISORY_INFRASTRUCTURE_OUTAGE",
      triage_notes: "",
      ...c,
    };
  };

  const claims: Claim[] = [
    claim(1, 1, 9 * DAY, {
      status: "PAID",
      reporter: addr("3f9e21"),
      filing_probe_code: "HTTP_502",
      failure_trace: "POST eth_blockNumber → HTTP 502 Bad Gateway from Frankfurt, Virginia and Singapore, 03:12–03:41 UTC. Cloudflare error page, origin unreachable.",
      samples_total: 5,
      samples_down: 4,
      last_sample_at: t - 9 * DAY + 2 * HOUR,
      resolved_at: t - 8 * DAY,
      slash_amount: gen(1),
      triage_notes: "Three regions saw the same 502 from the provider's edge while unrelated endpoints answered normally. That points to the provider's origin, not the reporter's network.",
    }),
    claim(2, 2, 34 * DAY, {
      status: "RECOVERED",
      reporter: addr("88aa10"),
      filing_probe_code: "TIMEOUT",
      failure_trace: "eth_chainId timed out after 10s from my laptop on hotel wifi, twice in a row.",
      samples_total: 4,
      samples_down: 1,
      resolved_at: t - 33 * DAY,
      triage_verdict: "ADVISORY_CLIENT_ARTIFACT",
      triage_notes: "The trace comes from one client on a captive-portal network. Validators got clean answers on 3 of 4 confirmation samples, so the outage was not sustained.",
    }),
    claim(3, 3, 7 * DAY, {
      status: "DISMISSED",
      reporter: addr("4d0c55"),
      appellant: addr("501a4a11"),
      appeal_bond: gen(2),
      filing_probe_code: "HTTP_503",
      ruling_probe_code: "UP",
      failure_trace: "getHealth → 503 'Node is behind by 212 slots' during the 14:00 UTC leader rotation.",
      samples_total: 3,
      samples_down: 1,
      resolved_at: t - 7 * DAY + 4 * HOUR,
      triage_verdict: "ADVISORY_INCONCLUSIVE",
      triage_notes: "A brief 503 during slot catch-up is consistent with both a real stall and a normal leader rotation. The triage abstained; the confirmation samples decided.",
    }),
    claim(4, 4, 5 * HOUR, {
      status: "UNDER_APPEAL",
      reporter: addr("61e2b3"),
      appellant: addr("b45e0c07"),
      appeal_bond: gen(2),
      filing_probe_code: "HTTP_500",
      failure_trace: "eth_chainId → HTTP 500 {\"error\":\"upstream connect error or disconnect/reset before headers\"} from 4 vantage points.",
      samples_total: 4,
      samples_down: 3,
      last_sample_at: t - 3 * HOUR,
      triage_notes: "An Envoy upstream reset returned by the provider's own gateway to several independent callers is an infrastructure failure on the provider's side.",
    }),
    claim(5, 9, 26 * HOUR, {
      status: "CLAIM_PENDING",
      reporter: addr("0a9f44"),
      filing_probe_code: "HTTP_503",
      failure_trace: "getHealth → HTTP 503 {\"code\":-32005,\"message\":\"Node is unhealthy\"} for 40 minutes; explorer shows block production stalled.",
      samples_total: 6,
      samples_down: 5,
      last_sample_at: t - 25 * HOUR,
      triage_notes: "The JSON-RPC error is the node declaring itself unhealthy, and block production stalled over the same window. Upstream outage.",
    }),
    claim(6, 8, 15 * 60, {
      status: "CLAIM_PENDING",
      reporter: addr("3f9e21"),
      filing_probe_code: "HTTP_503",
      failure_trace: "getHealth → HTTP 503 from us-east and eu-west since 13:52 UTC. Status page still green.",
      samples_total: 1,
      samples_down: 1,
      last_sample_at: t - 11 * 60,
      triage_notes: "Several regions report the same 503 from the provider while the status page lags behind. Likely a real upstream outage; the confirmation samples still decide.",
    }),
    claim(7, 6, 2 * 60, {
      status: "CLAIM_PENDING",
      reporter: addr("77c3e8"),
      filing_probe_code: "TIMEOUT",
      failure_trace: "eth_blockNumber hangs >10s, then connection reset. Seen from a single VPS in Tokyo.",
      triage_verdict: "ADVISORY_INCONCLUSIVE",
      triage_notes: "One vantage point only. A timeout from a single VPS could be local routing. The triage abstained; confirmation samples will decide.",
    }),
  ];

  return withDerived({ stats: {} as ProtocolStats, providers, policies, claims }, now);
}

/** Recomputes the contract's derived fields (bonds, outcomes, protocol totals)
 * from the provider, policy and claim records. */
export function withDerived(s: Snapshot, now: number): Snapshot {
  const providers = s.providers.map((p) => {
    const open = s.claims.filter((c) => c.provider_id === p.provider_id && (c.status === "CLAIM_PENDING" || c.status === "UNDER_APPEAL")).length;
    return { ...p, open_claims: open, required_reporter_bond: C.reporterBondBase * 2n ** BigInt(open) };
  });
  const claims = s.claims.map((c) => {
    const pending = c.status === "CLAIM_PENDING" || c.status === "UNDER_APPEAL";
    const base = c.payout * BigInt(C.appealBondBps) / 10_000n;
    return { ...c, outcome: pending ? outcome(c, now) : ("" as const), required_appeal_bond: base > C.appealBondBase ? base : C.appealBondBase };
  });
  const open = claims.filter((c) => c.status === "CLAIM_PENDING" || c.status === "UNDER_APPEAL");
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const total_underwriting = sum(providers.map((p) => p.free_capital + p.committed_capital));
  const total_escrow = sum(open.map((c) => c.payout));
  const total_bonds = sum(open.map((c) => c.reporter_bond + c.appeal_bond));
  const total_premiums = sum(s.policies.map((p) => p.premium));
  const total_payouts = sum(claims.filter((c) => c.status === "PAID").map((c) => c.payout));
  const stats: ProtocolStats = {
    providers: providers.length,
    policies: s.policies.length,
    claims: claims.length,
    total_underwriting,
    total_escrow,
    total_bonds,
    total_claimable: 0n,
    total_premiums,
    total_payouts,
    liabilities: total_underwriting + total_escrow + total_bonds,
    net_inflow: total_underwriting + total_escrow + total_bonds,
    solvent: true,
    challenge_window_s: C.challengeWindow,
    reporter_bond_base: C.reporterBondBase,
    appeal_bond_base: C.appealBondBase,
    slash_bps: C.slashBps,
    min_underwriting: C.minUnderwriting,
    min_coverage: C.minCoverage,
  };
  return { stats, providers, policies: s.policies, claims };
}

export function outcome(c: Claim, now: number): NonNullable<Claim["outcome"]> {
  if (now <= c.confirm_after + C.resolutionWindow) return "PENDING";
  const total = c.samples_total ?? 0;
  const down = c.samples_down ?? 0;
  if (total < C.minSamples) return "INSUFFICIENT";
  return down * 2 > total ? "SUSTAINED" : "RECOVERED";
}
