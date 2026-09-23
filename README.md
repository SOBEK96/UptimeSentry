# UptimeSentry

Parametric SLA insurance for public RPC and API endpoints, adjudicated on-chain by GenLayer validator consensus.

Infrastructure providers underwrite their own public endpoints with native GEN. Protocols and teams that depend on those endpoints buy fully collateralised coverage. When an endpoint goes down, anyone can report it. GenLayer validators independently probe the **registered** endpoint with the **registered** payload, and the protocol pays out, slashes and refunds based on what they observe, not on what anyone claims.

## Deployment

| | |
| --- | --- |
| Network | GenLayer Studio Next (chain 61997) |
| Contract | [`0x4f8D4900Ee3fCe15B9C3f992601139C5C6e70b3E`](https://explorer-studio-next.genlayer.com/address/0x4f8D4900Ee3fCe15B9C3f992601139C5C6e70b3E) |
| Deploy tx | `0xadc9275b08292460943355a7c0242fa3aeaa1a8e87fc4c22e0371dd834999ee1` |
| Record | [`deployments/studio-next.json`](deployments/studio-next.json) (on-chain code sha256 matches `contracts/uptimesentry.py`) |
| Smoke test | `register_provider` for `https://mainnet.base.org` with 10 GEN (`0x2ea7108b…02d9`), then `attest_probe`: validators agreed the endpoint is `UP` (`0x5d247731…ddcbf`) |

```
contracts/uptimesentry.py      Intelligent contract (GenVM, py-genlayer runner 5jycge4…)
specs/architecture.md          Protocol specification: binding, lifecycle, escrow, game theory
tests/direct/                  Direct-mode suite (gltest), 100% line coverage of the contract
tests/integration/             Full-consensus suite (gltest) for Studio Next / genlayer up
scripts/deploy.py              Deploy → verify on-chain source → record deployments/*.json
scripts/smoke_test.py          Live smoke test of the recorded deployment
scripts/fee_profile.py         Builds fee-profile.json from finalized receipts
deployments/studio-next.json   Deployment and smoke-test record
fee-profile.json               Fee observations measured on Studio Next
frontend/                      Operator console (Vite + React + Tailwind + genlayer-js)
Makefile                       install · lint · test · smoke · deploy · profile · build
```

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
file_incident ──► CLAIM_PENDING ──(24h challenge window, no appeal)──► claim_payout ──► PAID
                      │
                      └── file_appeal ──► UNDER_APPEAL ──(after the downtime window)──► resolve_appeal
                                                                                            │
                                               target still failing ◄──────────────────────┤
                                               CONFIRMED ──► claim_payout ──► PAID          │
                                                                                            │
                                               target healthy ◄────────────────────────────┘
                                               DISMISSED (escrow returns to the pool)
```

1. **Filing.** `file_incident` requires a native bond and evidence that names the policy's provider id, the exact registered endpoint URL and the exact registered probe payload. Validators then probe the target. If consensus finds it healthy, the call reverts with `ERR_NO_OUTAGE_OBSERVED`. If it's failing, the full coverage moves from the provider's committed capital into escrow.
2. **Challenge window.** The payout stays in escrow for 24 hours. With no appeal, anyone can call `claim_payout` once the window closes. The insured gets the payout and the reporter gets their bond back.
3. **Appeal.** A provider or watchdog can post an appeal bond to move the claim to `UNDER_APPEAL`. While it's there, every payout attempt fails with `ERR_PAYOUT_LOCKED: funds preserved until appeal resolution`.
4. **Ruling.** `resolve_appeal` opens once the provider's allowed downtime window has passed since filing. Validators probe the target again. A confirmed breach therefore means two independent consensus observations of failure, spanning the SLA window.

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
- **Capital lock.** A provider can't withdraw free capital while any claim against them is unresolved, so the slashing base can't be pulled out ahead of a ruling.
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
| `deposit_underwriting(provider_id)` / `withdraw_underwriting(provider_id, amount)` | payable write / write | Owner only; withdrawals blocked while claims are open |
| `set_accepting_policies(provider_id, accepting)` | write | Pause or resume new coverage |
| `purchase_coverage(provider_id, coverage, term_days)` | payable write | Value must equal `quote_premium` exactly |
| `release_expired_policy(policy_id)` | write | Returns an expired policy's backing to free capital |
| `file_incident(policy_id, target_provider_id, target_endpoint_url, probe_payload, failure_trace)` | payable write | Consensus probe; escrows payout |
| `file_appeal(claim_id)` | payable write | During the challenge window |
| `resolve_appeal(claim_id)` | write | After the downtime window; consensus probe |
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
