# UptimeSentry

Parametric SLA insurance for public RPC and API endpoints, adjudicated on-chain by GenLayer validator consensus.

Infrastructure providers underwrite their own public endpoints with native GEN. Protocols and teams that depend on those endpoints buy fully collateralised coverage. When an endpoint goes down, anyone can report it. GenLayer validators independently probe the **registered** endpoint with the **registered** payload, and the protocol pays out, slashes and refunds based on what they observe, not on what anyone claims.

UptimeSentry is a GenLayer **Intelligent Contract**. It combines four things no oracle-fed insurance contract can:

- **Live probes under consensus:** validators probe the endpoint themselves and must agree on what they see.
- **Parametric settlement:** a claim is decided by a sustained-outage rule over those observations.
- **Advisory LLM triage:** a language model reviews every incident report and records its verdict as evidence, without overruling the validators.
- **Game-theoretic bonds:** reporters, appellants and providers all put GEN at risk.

## Verified contracts

| Deployment | Address | Status |
| --- | --- | --- |
| **Studio Next** (chain 61997), current | [`0x4d580Dc355510e170529473906A455f51610F405`](https://explorer-studio-next.genlayer.com/address/0x4d580Dc355510e170529473906A455f51610F405) | Round-2 hardened contract. On-chain source sha256 `a0aea60c…d5656` matches `contracts/uptimesentry.py` byte for byte. Deploy tx [`0x2af0aebd…f16d`](https://explorer-studio-next.genlayer.com/tx/0x2af0aebd25f0fd7af132ef24a902ee683ba48fcf58318bcdec99161cfe95f16d). Record: [`deployments/studio-next.json`](deployments/studio-next.json) |
| Studio Next, v3 | [`0x23474374a1B493a1fEe91075a932BcaaCbF6013B`](https://explorer-studio-next.genlayer.com/address/0x23474374a1B493a1fEe91075a932BcaaCbF6013B) | Superseded; identical source to the current contract. Record: [`deployments/studio-next.v3.json`](deployments/studio-next.v3.json) |
| Studio Next, v2 | [`0xd21347E2516532b036Ae00b2152466f73b7b5E7f`](https://explorer-studio-next.genlayer.com/address/0xd21347E2516532b036Ae00b2152466f73b7b5E7f) | Superseded (round-1 hardening). Record: [`deployments/studio-next.v2.json`](deployments/studio-next.v2.json) |
| Studio Next, v1 | [`0x4f8D4900Ee3fCe15B9C3f992601139C5C6e70b3E`](https://explorer-studio-next.genlayer.com/address/0x4f8D4900Ee3fCe15B9C3f992601139C5C6e70b3E) | Superseded (pre-review). Record: [`deployments/studio-next.v1.json`](deployments/studio-next.v1.json) |

Live activity on v3 (`0x23474374…013B`), which runs the identical source. All calls finalized with `MAJORITY_AGREE` (validator consensus). The current contract is freshly deployed and empty; `scripts/bootstrap_live.py` seeds it the same way.

| Call | Transaction | Result |
| --- | --- | --- |
| `register_provider` (`https://mainnet.base.org`, 10 GEN pool) | [`0x5d28adcf…4527`](https://explorer-studio-next.genlayer.com/tx/0x5d28adcfa579a1ced16b70df4b63f8ffa46d9b48afb7030c05f0617fcc524527) | Provider `0xda1e4a0b…7deb` |
| `purchase_coverage` (1 GEN, 30 days) | [`0x5ed1235e…bc52`](https://explorer-studio-next.genlayer.com/tx/0x5ed1235e72afc93cb7f398452428a675cb6a86aa1bf1c43894c16e70d828bc52) | Policy `…0001` |
| `attest_probe` | [`0xcd3e6e6d…5d3a`](https://explorer-studio-next.genlayer.com/tx/0xcd3e6e6d24d6c2bec70c90a667bbfa76b5d6eec8a3b7215e3d80f8895d9f5d3a) | Validators agreed: `UP` |
| `run_sla_drill` (write simulation) | none (not committed) | `REJECTED_TARGET_HEALTHY`, live probe `UP` |

## Repository

```
contracts/uptimesentry.py      Intelligent contract (GenVM, py-genlayer runner 5jycge4…)
specs/architecture.md          Protocol specification: binding, lifecycle, escrow, game theory, limitations
tests/direct/                  57 direct-mode tests incl. both security-review PoC suites; 100% line coverage
tests/integration/             Full-consensus suite (gltest) for Studio Next / genlayer up
scripts/deploy.py              Deploy → verify on-chain source → record deployments/*.json
scripts/bootstrap_live.py      Seed a deployment with live provider, policy, probe and drill
scripts/smoke_test.py          Live smoke test of the recorded deployment
scripts/fee_profile.py         Builds fee-profile.json from finalized receipts
deployments/                   Deployment and smoke-test records
frontend/                      Operator console (Vite + React + Tailwind + genlayer-js)
Makefile                       install · lint · test · smoke · deploy · profile · build
```

## Security hardening

These are the results of a security review. Each finding has a proof-of-concept test in [`test_review_poc.py`](tests/direct/test_review_poc.py) (round 1) or [`test_review_poc2.py`](tests/direct/test_review_poc2.py) (round 2).

| Threat | Defence |
| --- | --- |
| Faking an outage by getting validators rate-limited | HTTP 429 and 403 are *indeterminate*, never DOWN. Filing, sampling and probing fail closed with `ERR_RATE_LIMITED: endpoint returned 429/403, cannot determine outage` |
| One momentary outage paying out | Two-stage confirmation. The filing probe must see DOWN, then at least 3 consensus samples in the window `[confirm_after, confirm_after + 2h]` (10 min apart, via `confirm_outage`) must be mostly DOWN. A demonstrated recovery (≥ 3 samples, no DOWN majority) closes as `RECOVERED`. Fewer than 3 samples closes as `INDETERMINATE_INSUFFICIENT_SAMPLES` and refunds the reporter's bond |
| A provider draining capital as an outage starts | Two-step withdrawal: `request_underwriting_withdrawal`, then `execute_underwriting_withdrawal` within 24h–72h of the request, with no open claims, and only while a consensus probe sees the endpoint healthy (`ERR_ENDPOINT_UNHEALTHY`). Queued capital stays slashable until it leaves |
| A caller picking a favourable moment for the ruling | `resolve_appeal` opens only after the sampling window and runs no probe. The ruling is a pure function of the recorded samples |
| SSRF against validators | Only public domain names on port 443. Every IP literal is rejected (hex, octal, short and IPv6 forms), as are wildcard-DNS rebinding hosts (`nip.io`, `sslip.io`, `localtest.me`…), `*.localhost`, internal suffixes and credentials in the URL |
| Evidence aimed at a different target | Evidence must name the exact registered URL and probe payload, or the filing fails with `ERR_UNBOUND_EVIDENCE` |
| Spam and delay tactics | Reporter bonds double with each open claim. Appeal bonds double with each dispute against the same provider within 7 days |

The known limitations are rate-limit starvation, DNS rebinding after registration, and endpoint squatting under permissionless registration (planned v2 fix: `/.well-known/uptimesentry.txt` ownership proof). All are documented in [`specs/architecture.md` §9](specs/architecture.md#9-known-limitations).

## GenVM-native LLM triage (advisory)

Every filing runs `gl.nondet.exec_prompt` after validators have confirmed the target is failing. The model classifies the reporter's `failure_trace` against the failure code the contract itself observed:

- `ADVISORY_INFRASTRUCTURE_OUTAGE`: the trace describes the provider failing.
- `ADVISORY_CLIENT_ARTIFACT`: the trace describes the reporter's own problem.
- `ADVISORY_INCONCLUSIVE`: neither.

The verdict and a short `triage_notes` summary are stored on the claim and included in its evidence hash, as expert evidence for appeals and dashboards.

- **Never a veto.** The model cannot overrule the validators' objective DOWN verdict, and a failed or unusable model answer is recorded as `ADVISORY_INCONCLUSIVE`. The model never blocks a filing or changes a payout.
- **The leader may abstain but not contradict.** Validators accept the leader's verdict when their own model agrees, cannot decide, or when the leader abstained.
- **The provider can't steer it.** The endpoint's response headers and body are provider-controlled and never reach the model. The reporter's trace is sanitised and delimited as untrusted data.

## How it works

### Actors

| Role | What they do | What they put at stake |
| --- | --- | --- |
| Provider | Registers a public, keyless endpoint and the probe that defines "healthy"; sets the allowed downtime window, availability target and premium rate | Underwriting pool (min 10 GEN) |
| Insured | Buys coverage for 1–90 days | Premium, paid once |
| Reporter | Files an incident against a policy | Reporter bond (1 GEN, escalating) |
| Appellant | Disputes a pending claim (provider or any watchdog) | Appeal bond (≥2 GEN or 10% of payout, escalating) |

### Claim lifecycle

```
file_incident ──► CLAIM_PENDING ──► confirm_outage × n  (samples in [confirm_after, +2h], ≥10 min apart)
     (probe DOWN,            │
      advisory LLM triage)            ├─ no appeal: after the 24h deadline and the window close ─► claim_payout
                             │      DOWN majority of ≥3 samples ─► PAID
                             │      ≥3 samples, no DOWN majority ► RECOVERED (bond to the pool)
                             │      fewer than 3 samples ────────► INDETERMINATE_INSUFFICIENT_SAMPLES (bond refunded)
                             │
                             └─ file_appeal ─► UNDER_APPEAL ─(window closed)─► resolve_appeal
                                    DOWN majority of ≥3 samples ─► CONFIRMED ─► claim_payout ─► PAID
                                    otherwise ─────────────────► DISMISSED
```

1. **Filing.** `file_incident` requires a native bond and evidence that names the policy's provider id, the exact registered endpoint URL and the exact registered probe payload. Validators then probe the target:
   - **Healthy:** the call reverts with `ERR_NO_OUTAGE_OBSERVED`.
   - **HTTP 429/403:** the call reverts with `ERR_RATE_LIMITED`. A rate limit or WAF block is not evidence of an outage.
   - **Failing:** the full coverage moves into escrow, and an advisory LLM triage of the reporter's trace is stored with the claim.
2. **Confirmation.** One failure never pays. Once the provider's allowed downtime has elapsed, anyone may call `confirm_outage` for a fresh consensus sample, at most one every 10 minutes, for 2 hours. The outcome is **sustained** only with at least 3 samples and a strict majority DOWN. Otherwise the claim closes as **recovered**, with the escrow back in the pool and the reporter's bond forfeited to it.
3. **Challenge window.** The payout stays in escrow for 24 hours. With no appeal, `claim_payout` settles the claim once both the deadline and the confirmation window have passed. It pays a sustained outage and closes a recovered one.
4. **Appeal.** A provider or watchdog can post an appeal bond to move the claim to `UNDER_APPEAL`. While it's there, every payout attempt fails with `ERR_PAYOUT_LOCKED: funds preserved until appeal resolution`.
5. **Ruling.** `resolve_appeal` opens when the confirmation window closes. It runs no probe: the ruling is a pure function of the recorded samples, so the moment it is called cannot change it.

### Settlement

| Outcome | Insured | Reporter | Appellant | Provider |
| --- | --- | --- | --- | --- |
| Unchallenged | Payout | Bond returned | n/a | Loses the escrowed coverage |
| Appeal → **CONFIRMED** | Payout + half the slash + forfeited appeal bond | Bond + half the slash | Loses bond | Loses coverage; 20% of the payout slashed from free capital |
| Appeal → **DISMISSED** | Policy returns to active (or its capital is released if expired) | Bond slashed to the provider's pool | Bond refunded | Escrow returns to the pool |

Credits go to a pull-based balance and are withdrawn with `withdraw()`. The insured's payout is transferred directly by `claim_payout`.

### Anti-griefing

- **Escalating reporter bonds.** The required bond doubles for each claim already open against the same provider (`1 × 2^open_claims` GEN, capped at 256×). Spamming reports to lock a provider's capital gets exponentially expensive.
- **Escalating appeal bonds.** The Nth appeal against a provider within a 7-day epoch costs `2^(N-1)` times the base. Blanket-appealing every claim to stall payouts, or racing sybil appeals, drains the appellant rather than the pool.
- **Withdrawal timelock.** Withdrawals take two steps. `request_underwriting_withdrawal` queues an amount. `execute_underwriting_withdrawal` works only after 24 hours and with no open claims. Queued capital stays in the pool and stays slashable, so a provider can't pull the slashing base out as an outage starts.
- **Conflict rules.** Providers can't insure or report on their own endpoint. Reporters and insured holders can't appeal their own claim.

### Evidence binding and telemetry

- **Exact target match.** Endpoints must be `https://` public domains. Userinfo, fragments, private/loopback/link-local hosts, credential-bearing query parameters and opaque API-key path segments are all rejected, so every validator probes the same keyless public target.
- **Allowed probes.** A probe is either a single parameterless JSON-RPC read (`eth_blockNumber`, `eth_chainId`, `eth_syncing`, `getHealth`, `getSlot`, …) stored in canonical form, or an HTTP GET health check.
- **Health verdict.**
  - *Healthy:* HTTP 2xx, and for JSON-RPC a `result` with no `error`.
  - *Failing:* any other status, RPC errors, missing results, malformed bodies, and transport failures (DNS, TLS, timeouts).
- **Consensus rule.** Validators agree on the healthy/failing verdict only. The failure code (`HTTP_503`, `UNREACHABLE`, …) is recorded but not compared, because the same outage can show up differently from different nodes.
- **Fail closed.** Any mismatch in provider id, URL or payload reverts with `ERR_UNBOUND_EVIDENCE: incident telemetry does not match registered target`.
- **Evidence hash.** Each claim records `sha256` over the bound target, payload, reporter trace, filing time and the observed failure code.

### Diagnostic drill

`run_sla_drill(policy_id, provider_id, endpoint_url, probe_payload)` is a view. It runs the same binding checks and a live consensus probe as `file_incident`, and returns the verdict a filing would get right now (`CLAIM_WOULD_BE_ACCEPTED`, `REJECTED_TARGET_HEALTHY`, `REJECTED_POLICY_NOT_ACTIVE` or `REJECTED_UNBOUND_EVIDENCE`). It never touches pools, escrow, bonds or counters.

### Observed availability

`attest_probe(provider_id)` records one consensus health observation. It's open to anyone and limited to once every 5 minutes per endpoint. The running `probes_up / probes_total` is published as `observed_availability_bps` next to the provider's SLA target.

### Ledger

All value is native GEN: `gl.message.value` in and `gl.chain.Account(...).emit_transfer` out. The contract tracks every unit:

```
total_deposited − total_withdrawn == underwriting + escrow + bonds + claimable
```

`get_protocol_stats()` exposes both sides of that equation and a `solvent` flag. The test suite asserts it after every flow.

## Contract interface

| Method | Kind | Notes |
| --- | --- | --- |
| `register_provider(name, endpoint_url, probe_kind, probe_payload, max_downtime_s, target_availability_bps, premium_bps)` | payable write | Pool ≥ 10 GEN; downtime window 5 min–24 h; target 90–100%; premium 0.01–50% per 30 days |
| `deposit_underwriting(provider_id)` | payable write | Owner only |
| `request_underwriting_withdrawal(provider_id, amount)` / `execute_underwriting_withdrawal(provider_id)` / `cancel_underwriting_withdrawal(provider_id)` | write | Owner only; executes after a 24h timelock with no open claims |
| `set_accepting_policies(provider_id, accepting)` | write | Pause or resume new coverage |
| `purchase_coverage(provider_id, coverage, term_days)` | payable write | Value must equal `quote_premium` exactly |
| `release_expired_policy(policy_id)` | write | Returns an expired policy's backing to free capital |
| `file_incident(policy_id, target_provider_id, target_endpoint_url, probe_payload, failure_trace)` | payable write | Consensus probe; escrows payout |
| `file_appeal(claim_id)` | payable write | During the challenge window |
| `confirm_outage(claim_id)` | write | Consensus sample in `[confirm_after, +2h]`, one per 10 min |
| `resolve_appeal(claim_id)` | write | After the confirmation window; decided from the samples |
| `claim_payout(claim_id)` | write | Pays the insured |
| `withdraw()` | write | Pull credited bonds, rewards and refunds |
| `attest_probe(provider_id)` | write | Consensus health observation |
| `run_sla_drill(...)` | view | Read-only adjudication dry run |
| `get_provider`, `get_policy`, `get_claim`, `list_providers`, `list_policies`, `list_claims`, `quote_premium`, `required_reporter_bond`, `required_appeal_bond`, `claimable_of`, `get_protocol_stats` | view | |

Amounts are atto-GEN (1 GEN = 10^18). Errors are raised as `gl.vm.UserError("ERR_…")`.

## Development

The full mechanism, including every guard, bond formula and settlement rule with the tests that pin it, is specified in [`specs/architecture.md`](specs/architecture.md).

```bash
make install            # .venv from requirements-dev.txt (exact pins) + frontend packages
make lint               # genvm-lint lint + validate
make test               # direct suite, then integration (skips with a reason if no funded network)
make test-integration   # integration suite as a hard gate (NETWORK=studio_devnet by default)
make smoke              # live read-only check of the recorded deployment
make deploy-check       # every deploy step up to signing
make build              # frontend production build
make gate               # lint + direct tests + build
```

The pinned GenLayer tools are one release-candidate set: `genlayer-test==0.30.0rc2`, `genlayer-py==0.19.0rc2` and `genvm-linter==0.11.1rc2`. The contract's runner (`5jycge4…`) needs `genlayer-test` 0.30.0rc2; older releases fail to load it with "unexpected end of memory".

### Tests

- **Direct** (`tests/direct/`): every consensus probe runs its leader function against HTTP responses pinned per test. `run_validator` then exercises the validator side, including disagreement when a validator sees a different endpoint state.
- **Integration** (`tests/integration/`): runs the contract under real leader and validator consensus with live web probes. See [its README](tests/integration/README.md) for accounts and networks, and for why the bundled GLSim cannot run it.

### Live scripts

Both scripts read `GENLAYER_PRIVATE_KEY` for signing and are read-only without it.

```bash
python scripts/smoke_test.py                 # chain, source hash, ledger, providers, drill
python scripts/smoke_test.py --write         # + attest_probe transaction
python scripts/deploy.py --dry-run           # lint, hash, network, fee quote
python scripts/deploy.py [--network localnet] [--force]
python scripts/fee_profile.py                # rebuild fee-profile.json from the recorded txs
```

### Frontend

```bash
cd frontend
npm install
npm run dev
npm run build
```

`frontend/.env` binds the console to the Studio Next deployment. Environment variables:

- `VITE_UPTIMESENTRY_ADDRESS`: the deployed contract address.
- `VITE_GENLAYER_NETWORK`: `testnetBradbury` (default), `testnetAsimov`, `studionet` or `studioDevnet` (Studio Next, chain 61997).
- `VITE_GENLAYER_RPC_URL` and `VITE_GENLAYER_EXPLORER_URL`: optional RPC and explorer overrides.

The console needs `genlayer-js` 2.x: the runner rejects the 1.x call encoding with `malformed_entry`. `vercel.json` builds `frontend/` and serves `frontend/dist`.

## Reproduce locally

```bash
make install                                        # .venv (exact pins) + frontend packages
make lint                                           # genvm-lint lint + validate: 0 errors, 0 warnings
make test                                           # 57 direct tests, then the integration suite
.venv/bin/python -m pytest tests/direct -q          # direct suite only
genvm-lint lint contracts/uptimesentry.py
genvm-lint validate contracts/uptimesentry.py
make smoke                                          # read-only check of the live deployment
```

## License

[MIT](LICENSE) © 2026 SOBEK96

