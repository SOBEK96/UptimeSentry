# UptimeSentry architecture specification

Status: implemented. Source of truth: `contracts/uptimesentry.py`. Every rule below is enforced by that contract. The section on each rule names the tests that pin it.

## 1. Scope and actors

UptimeSentry is parametric SLA insurance for public RPC and API endpoints. It is one GenLayer intelligent contract. There is no admin key, upgrade path or off-chain component in the settlement path.

| Actor | Calls | Stake |
| --- | --- | --- |
| Provider | `register_provider`, `deposit_underwriting`, `request/execute/cancel_underwriting_withdrawal`, `set_accepting_policies` | Underwriting pool (≥ 10 GEN) |
| Insured holder | `purchase_coverage` | Premium, paid once |
| Reporter | `file_incident` | Reporter bond (≥ 1 GEN, escalating) |
| Appellant (provider or any watchdog) | `file_appeal` | Appeal bond (≥ max(2 GEN, 10% of payout), escalating) |
| Anyone | `confirm_outage`, `resolve_appeal`, `claim_payout`, `release_expired_policy`, `attest_probe`, `withdraw` | Fee deposit only |

All amounts are native GEN in atto units (10^18). Value enters only through `gl.message.value`. It leaves only through `gl.chain.Account(addr).emit_transfer(value, on="finalized")`.

## 2. Target-bound telemetry

### 2.1 What a provider binds at registration

- **Endpoint URL**, validated by `_validate_endpoint`. The URL must:
  - use `https://`, be 12–256 characters, and contain no whitespace or control characters;
  - have no userinfo (`@`) and no fragment;
  - have a public domain name as host, on the default port (no port, or `:443`). The following are all rejected:
    - hosts without a dot, `localhost` and the suffixes `.local`, `.internal`, `.localhost`, `.lan`, `.home`, `.corp`, `.localdomain` and `.arpa`, checked after stripping a trailing dot;
    - **every IP literal in any notation:** dotted quads, short forms (`127.1`), hex (`0x7f.0.0.1`), octal (`0177.0.0.1`) and IPv6 (`[::1]`, `[::ffff:127.0.0.1]`);
    - wildcard-DNS rebinding services that map a name to an embedded IP: `nip.io`, `sslip.io`, `xip.io`, `localtest.me`, `lvh.me`, `vcap.me`, `lacolhost.com` and `traefik.me`.

    Validators must never be pointed at private infrastructure.
  - be keyless. A query parameter whose name contains `key`, `token`, `secret`, `auth`, `sig`, `pass` or `session` is rejected with `ERR_KEYED_ENDPOINT`. So is any path segment of 20+ mixed alphanumeric characters, which is how hosted gateways embed API keys (e.g. `/v3/<32 hex>`). Every validator must be able to query the same target with no credentials.
- **Probe definition**, normalised by `_canonical_probe_payload`:
  - `JSONRPC`: a single JSON-RPC 2.0 object, with no batches and no extra keys, calling a parameterless read-only method from `JSONRPC_PROBE_METHODS` (`eth_blockNumber`, `eth_chainId`, `eth_syncing`, `eth_gasPrice`, `net_version`, `net_listening`, `web3_clientVersion`, `getHealth`, `getSlot`, `getBlockHeight`, `getVersion`). It is stored re-serialised with sorted keys, so formatting never changes its identity.
  - `HTTP_GET`: an empty payload; the URL is the health check.
- **SLA terms**:
  - `max_downtime_s` ∈ [300, 86 400], the time an outage must persist to be a breach;
  - `target_availability_bps` ∈ [9 000, 10 000];
  - `premium_bps` ∈ [1, 5 000] per 30 days.

`provider_id` is `0x` plus the first 40 hex characters of `sha256(endpoint_url)`. An endpoint can therefore be registered once (`ERR_PROVIDER_EXISTS`), and the id itself commits to the URL.

### 2.2 Evidence binding (fail closed)

`file_incident(policy_id, target_provider_id, target_endpoint_url, probe_payload, failure_trace)` checks, before any network access:

1. `target_provider_id == policy.provider_id`
2. `target_endpoint_url == provider.endpoint_url`, as an exact string match (a trailing `/` is a different target)
3. `canonical(probe_payload) == provider.probe_payload`. An unparseable payload counts as a mismatch.

Any failure raises exactly `ERR_UNBOUND_EVIDENCE: incident telemetry does not match registered target`. The transaction reverts, so no claim, bond or escrow is created. Reporter-supplied telemetry is never probed. Validators only ever probe the registered target with the registered payload.

`failure_trace` (1–2 000 characters) is the reporter's account of the outage. It is stored, and hashed into `evidence_hash = sha256(canonical{claim_id, provider_id, endpoint_url, probe_payload, failure_trace, filed_at, observed_code})`. It never influences the verdict.

Pinned by `test_reject_unbound_endpoint_evidence`, `test_endpoint_must_be_public_and_keyless`, `test_registration_guards`, `test_http_get_provider_lifecycle`, and `test_filing_fails_closed` (integration).

### 2.3 The consensus probe

`_consensus_probe(url, kind, payload)` runs `gl.vm.run_nondet(leader_fn, validator_fn)`:

- **Leader:** one request (`POST` of the canonical payload for `JSONRPC`, `GET` for `HTTP_GET`), reduced deterministically by `_classify_response` to `{up: bool, code: str}`:

  | Observation | `up` | `code` |
  | --- | --- | --- |
  | HTTP 429 or 403 (rate limit / WAF) | INDETERMINATE | `HTTP_429` / `HTTP_403` |
  | Any other non-2xx status | DOWN | `HTTP_<status>` |
  | Transport failure (DNS, TLS, connect/read timeout) | false | `UNREACHABLE` |
  | JSON-RPC body not JSON / not an object | false | `MALFORMED_RESPONSE` |
  | JSON-RPC `error` present | false | `RPC_ERROR` |
  | JSON-RPC `result` missing or null | false | `RPC_NO_RESULT` |
  | 2xx (and, for JSON-RPC, a non-null `result` with no `error`) | true | `UP` |

- **Validator:** rejects a leader result that isn't a `Return`, has a non-boolean `up`, or has a `code` inconsistent with `up`. Otherwise it probes the target itself and agrees only if its own `up` equals the leader's.

Only the boolean verdict is compared. The same outage can legitimately show as `HTTP_503` on one node and `UNREACHABLE` on another, so the code is recorded from the leader and treated as informational. Disagreement forces GenLayer's leader rotation, so a lone dishonest or partitioned leader cannot set the verdict.

Pinned by `test_validators_disagree_when_they_observe_a_different_state`, `test_validators_reject_malformed_leader_results`, `test_transport_failure_counts_as_outage`, `test_malformed_rpc_responses_are_failures`.

## 3. Parametric claim lifecycle

### 3.1 Coverage

`purchase_coverage(provider_id, coverage, term_days)`:

- **Terms:** coverage is at least 1 GEN, the term is 1–90 days, and the holder cannot be the provider.
- **Premium:** `coverage × premium_bps × term_days / (10 000 × 30)`. The attached value must equal it exactly (`ERR_PREMIUM_MISMATCH`).
- **Collateral:** policies are fully collateralised. `coverage` moves from the provider's free capital to committed capital for the policy's life. The premium is credited to free capital.

Once expired, anyone may call `release_expired_policy`, which returns the backing to free capital.

### 3.2 States

```
file_incident ──► CLAIM_PENDING ──► confirm_outage × n  (samples in [confirm_after, +2h], ≥10 min apart)
     (probe DOWN,            │
      LLM triage)            ├─ no appeal: after the 24h deadline and the window close ─► claim_payout
                             │      DOWN majority of ≥3 samples ─► PAID
                             │      otherwise ─────────────────► RECOVERED (escrow back to the pool)
                             │
                             └─ file_appeal ─► UNDER_APPEAL ─(window closed)─► resolve_appeal
                                    DOWN majority of ≥3 samples ─► CONFIRMED ─► claim_payout ─► PAID
                                    otherwise ─────────────────► DISMISSED
```

| Step | Preconditions | Effect |
| --- | --- | --- |
| `file_incident` | value > 0 (`ERR_ZERO_BOND`); evidence bound (§2.2); policy `ACTIVE` and unexpired; reporter ≠ provider; bond ≥ required (§5.1); **consensus probe reports failure**, else `ERR_NO_OUTAGE_OBSERVED` | Claim `CLAIM_PENDING`. `payout = policy.coverage` moves from committed capital to escrow. Policy becomes `CLAIM_OPEN`. `challenge_deadline = filed_at + 24 h`, `confirm_after = filed_at + max_downtime_s` |
| `confirm_outage` | claim `CLAIM_PENDING` or `UNDER_APPEAL`; `confirm_after ≤ now ≤ confirm_after + 2 h`; ≥ 600 s since the last sample; probe not INDETERMINATE (`ERR_RATE_LIMITED`) | Records one consensus sample (`samples_total`, `samples_down`) |
| `claim_payout` on `CLAIM_PENDING` | `now ≥ challenge_deadline` (`ERR_CHALLENGE_WINDOW_OPEN`); confirmation window closed (`ERR_OUTAGE_UNCONFIRMED`) | Sustained: payout to the holder, reporter bond credited back, claim `PAID`. Not sustained: claim `RECOVERED`, escrow returned, reporter bond forfeited to the provider's pool |
| `file_appeal` | value > 0; claim `CLAIM_PENDING`; `now < challenge_deadline`; appellant ∉ {reporter, holder}; bond ≥ required (§5.2) | Claim `UNDER_APPEAL` |
| `resolve_appeal` | claim `UNDER_APPEAL`; confirmation window closed (`ERR_ADJUDICATION_NOT_READY`) | The recorded samples decide `CONFIRMED` or `DISMISSED` (§4). No probe runs |
| `claim_payout` on `CONFIRMED` | none | Payout is transferred to the holder and the claim becomes `PAID` |

One claim at a time per policy: filing requires `ACTIVE`, and an open claim sets the policy to `CLAIM_OPEN`.

### 3.3 Why a sampled confirmation window

The filing probe proves the target is failing at `filed_at`. That alone never pays.

- **The trigger:** a breach needs failure *after* the provider's own allowed downtime. That means at least `MIN_CONFIRM_SAMPLES = 3` consensus samples, taken at least 10 minutes apart inside `[confirm_after, confirm_after + 2 h]`, with a strict majority DOWN. That is the parametric trigger for every claim, appealed or not.
- **Timing can't be gamed:** the outcome is computed only after the window closes, from every sample in it. Neither the claimant nor the provider can win by picking the moment of a single decisive probe.
- **No extra probes later:** `claim_payout` and `resolve_appeal` run none. A probe taken at payout time (≥ 24 h after filing) would dismiss every real breach that ended within the day.
- **Sampling is open to anyone:** the holder, reporter, provider or any watchdog can call `confirm_outage`.
- **Rate-limited samples don't count:** a 429/403 answer is refused rather than recorded. A provider that serves 429/403 to validators for the whole window starves the claim of samples, and it closes as recovered. That is the price of not letting rate limits prove outages. See §9.

**LLM triage.** Filing runs `gl.nondet.exec_prompt` on the contract-observed failure code and the reporter's `failure_trace`, which is sanitised and delimited as untrusted data. Validators must agree on the category.

- **What it can do:** `CLIENT_SIDE_ARTIFACT` rejects the filing (`ERR_CLIENT_SIDE_ARTIFACT`). `UPSTREAM_OUTAGE` and `INCONCLUSIVE` proceed, with the verdict and rationale stored on the claim and included in `evidence_hash`.
- **Why it's safe:** the model can only reject a reporter's own self-described problem. It never creates or enlarges a payout.
- **Why the provider can't steer it:** the endpoint's response body is provider-controlled and is never sent to the model, so a provider cannot inject instructions that block claims against itself.
- **Parsing:** the model is read as text and the JSON object is extracted from it. An unparseable answer reverts the filing (`ERR_TRIAGE_UNAVAILABLE`).

Pinned by `test_unchallenged_claim_pays_after_window`, `test_resolution_waits_for_downtime_window`, `test_legitimate_claim_settlement`, `test_fraudulent_claim_slashing`, `test_one_open_claim_per_policy_and_expiry`, and `test_outage_claim_escrows_and_locks_under_appeal` (integration).

## 4. Escrow preservation during disputes

- **Where the escrow sits:** from filing until settlement, the payout is held in `total_escrow`, outside both the provider's free and committed capital. The provider cannot withdraw it.
- **Locked while under appeal:** `claim_payout` on an `UNDER_APPEAL` claim raises exactly `ERR_PAYOUT_LOCKED: funds preserved until appeal resolution`, for every caller and at every time. That includes after the original challenge deadline, because the lock depends only on the state.
- **Frozen capital:** withdrawals are two-step. `request_underwriting_withdrawal` queues an amount. `execute_underwriting_withdrawal` succeeds only after `WITHDRAWAL_DELAY` (24 h), and only with no claim against the provider in `CLAIM_PENDING` or `UNDER_APPEAL` (`ERR_OPEN_CLAIMS`). Queued capital stays in free capital, slashable, until it leaves. If a slash leaves less than the queued amount, execution fails (`ERR_INSUFFICIENT_FREE_CAPITAL`). A provider therefore cannot drain the slashing base as an outage starts.
- **After a dismissal:** the escrow returns to committed capital if the policy is still in force (the policy goes back to `ACTIVE`). Otherwise it returns to free capital and the policy becomes `RELEASED`.

**Ledger invariant**, checked after every flow in both test suites:

```
total_deposited − total_withdrawn
    == total_underwriting + total_escrow + total_bonds + total_claimable
```

`get_protocol_stats()` exposes both sides and a `solvent` flag.

Pinned by `test_payout_locked_during_appeal`, `test_capital_locked_while_claims_open`, `test_dismissal_after_expiry_frees_capital`, `assert_solvent` in every lifecycle test.

## 5. Game theory, slashing and anti-griefing

### 5.1 Reporter bond

```
required_reporter_bond = 1 GEN × 2^min(open_claims(provider), 8)
```

Each claim already open against the same provider doubles the bond for the next one, up to 256×. Locking a provider's capital with a burst of reports costs exponentially more. Every filing also has to survive a consensus probe of a failing target. Against a healthy endpoint the transaction reverts, so false reports cost gas and achieve nothing.

### 5.2 Appeal bond

```
base                 = max(2 GEN, payout × 10%)
required_appeal_bond = base × 2^min(disputes against provider in current 7-day epoch, 8)
```

The Nth appeal against a provider within a rolling 7-day epoch costs `2^(N−1)` times the base. The epoch resets on the first appeal after 7 days have passed. A provider who appeals every claim to delay payouts pays escalating bonds and loses each one where the outage is real. Sybil watchdogs racing to appeal share the same per-provider counter. Only one appeal can be open per claim (`ERR_ALREADY_UNDER_APPEAL`).

### 5.3 Settlement

| Outcome | Insured holder | Reporter | Appellant | Provider |
| --- | --- | --- | --- | --- |
| Unchallenged, window closed | payout | bond returned | n/a | loses the escrowed coverage |
| Appeal → `CONFIRMED` | payout + (slash − reporter share) + forfeited appeal bond | bond + 50% of slash | forfeits bond | loses coverage, and `slash = min(free_capital, payout × 20%)` is taken from free capital |
| Appeal → `DISMISSED` | policy restored (or released if expired) | forfeits bond to the provider's free capital | full refund | escrow returned |

Bonds, rewards and refunds are credited to `claimable` and withdrawn with `withdraw()` (pull pattern). The payout goes straight to the holder in `claim_payout`.

### 5.4 Incentive summary

- **Honest reporter:** wins bond + 50% of slash when the provider contests a real breach. Should file when the outage is observed and expected to outlast `max_downtime_s`.
- **Dishonest reporter:** cannot file against a healthy target (it reverts). A brief blip filed as a breach loses the bond if appealed and the target recovers in time.
- **Provider:** gains nothing from contesting real breaches; it adds a 20% slash and forfeits the appeal bond. Contesting a blip recovers the escrow and wins the reporter's bond. Cannot pull capital while claims are open.
- **Holder:** payout is fixed and parametric. Receives the slash remainder and a forfeited appeal bond as compensation for delay.
- **Conflicts:** providers cannot insure or report on their own endpoint; reporters and holders cannot appeal their own claims.

Pinned by `test_reporter_bonds_escalate_with_open_claims`, `test_appeal_bonds_escalate_per_epoch`, `test_appeal_bond_scales_with_payout`, `test_slash_is_capped_by_free_capital`, `test_appeal_state_guards`, `test_filing_guards`.

## 6. Read-only diagnostics

- `run_sla_drill(policy_id, provider_id, endpoint_url, probe_payload)` is a view. It applies the §2.2 binding checks, reports policy state and bond pricing, and runs one live probe of the registered target. It returns the verdict a filing would get now: `CLAIM_WOULD_BE_ACCEPTED`, `REJECTED_TARGET_HEALTHY`, `REJECTED_POLICY_NOT_ACTIVE` or `REJECTED_UNBOUND_EVIDENCE`. Views cannot write state. On Studio Next, plain reads (`gen_call`) skip a method's non-deterministic block and fail with `leader_fault nondet_output absent`, so clients call the drill as a **write simulation**: one node executes it as leader, runs the live probe, and commits nothing. The simulation clock is fixed, so clients re-check policy expiry against real time. Pinned by `test_drill_isolation` (full-state equality before and after) and `test_drill_is_read_only_and_binding_aware` (integration).
- `attest_probe(provider_id)` is a write that records one consensus observation, limited to once per 300 s per provider. It feeds `observed_availability_bps = probes_up × 10 000 / probes_total`, which is published next to the SLA target.

## 7. Errors

All errors are `gl.vm.UserError` with an `ERR_*` prefix. The two required messages are exact strings: `ERR_UNBOUND_EVIDENCE: incident telemetry does not match registered target` and `ERR_PAYOUT_LOCKED: funds preserved until appeal resolution`. The full list is in `frontend/src/lib/errors.ts`, which maps each code to user-facing copy.

## 8. Verification

| Layer | Command | Covers |
| --- | --- | --- |
| Static | `make lint` | `genvm-lint lint` and `validate`: 0 errors, 0 warnings |
| Direct | `make test-direct` | 50 tests including the security-review PoCs (`tests/direct/test_review_poc.py`), 100% line coverage, leader and validator paths |
| Integration | `make test-integration` | Full consensus on Studio Next: deploy, registration and its fail-closed guards, coverage, live `attest_probe`, drill, filing guards, a real outage claim escrowed and locked under appeal; `UPTIMESENTRY_SLOW=1` adds the ruling and payout |
| Live | `make smoke` | Deployed source hash, ledger solvency, provider state and drill against the recorded deployment |

## 9. Known limitations

- **Rate-limit starvation.** HTTP 429/403 answers are never counted as downtime, so an attacker cannot fake an outage by getting validators rate-limited. The flip side: a provider that answers 429/403 to validators for the entire confirmation window starves a claim of samples, and it closes as recovered. Serving 429 to everyone is, to users, an outage. Counting a *persistent* 429 across the whole window as DOWN is a possible future rule; this contract deliberately fails closed instead.
- **DNS rebinding.** Endpoint validation happens at registration and sees only the name. A public domain can later be pointed at a private address, and the contract cannot see resolution. Egress policy on validator nodes is the enforcing layer.
- **Studio Next reads.** Plain reads there skip non-deterministic blocks, so clients call `run_sla_drill` as a write simulation (§6).

