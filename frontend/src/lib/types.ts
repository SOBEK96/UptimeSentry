export type ProbeKind = "JSONRPC" | "HTTP_GET";

export interface Provider {
  provider_id: string;
  owner: string;
  name: string;
  endpoint_url: string;
  probe_kind: ProbeKind;
  probe_payload: string;
  max_downtime_s: number;
  target_availability_bps: number;
  observed_availability_bps: number;
  premium_bps: number;
  accepting: boolean;
  free_capital: bigint;
  committed_capital: bigint;
  open_claims: number;
  probes_total: number;
  probes_up: number;
  last_probe_at: number;
  last_probe_code: string;
  incidents_confirmed: number;
  incidents_dismissed: number;
  total_slashed: bigint;
  total_paid_out: bigint;
  registered_at: number;
  required_reporter_bond: bigint;
}

export type PolicyStatus = "ACTIVE" | "CLAIM_OPEN" | "CLAIMED" | "RELEASED";

export interface Policy {
  policy_id: string;
  provider_id: string;
  holder: string;
  coverage: bigint;
  premium: bigint;
  starts_at: number;
  expires_at: number;
  status: PolicyStatus;
}

export type ClaimStatus = "CLAIM_PENDING" | "UNDER_APPEAL" | "CONFIRMED" | "DISMISSED" | "PAID";

export interface Claim {
  claim_id: string;
  policy_id: string;
  provider_id: string;
  reporter: string;
  holder: string;
  payout: bigint;
  reporter_bond: bigint;
  appellant: string;
  appeal_bond: bigint;
  required_appeal_bond: bigint;
  status: ClaimStatus;
  filed_at: number;
  challenge_deadline: number;
  confirm_after: number;
  resolved_at: number;
  filing_probe_code: string;
  ruling_probe_code: string;
  failure_trace: string;
  evidence_hash: string;
  slash_amount: bigint;
}

export interface ProtocolStats {
  providers: number;
  policies: number;
  claims: number;
  total_underwriting: bigint;
  total_escrow: bigint;
  total_bonds: bigint;
  total_claimable: bigint;
  total_premiums: bigint;
  total_payouts: bigint;
  liabilities: bigint;
  net_inflow: bigint;
  solvent: boolean;
  challenge_window_s: number;
  reporter_bond_base: bigint;
  appeal_bond_base: bigint;
  slash_bps: number;
  min_underwriting: bigint;
  min_coverage: bigint;
}

export type DrillVerdict =
  | "CLAIM_WOULD_BE_ACCEPTED"
  | "REJECTED_TARGET_HEALTHY"
  | "REJECTED_POLICY_NOT_ACTIVE"
  | "REJECTED_UNBOUND_EVIDENCE";

export interface DrillResult {
  bound: boolean;
  verdict: DrillVerdict;
  error: string;
  observed_up: boolean;
  code: string;
  required_reporter_bond: bigint;
  payout?: bigint;
  challenge_window_s?: number;
  confirm_after_s?: number;
  observed_at?: number;
}
