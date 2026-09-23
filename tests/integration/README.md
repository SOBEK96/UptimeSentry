# UptimeSentry integration tests

These tests run the contract under full leader and validator consensus on a live GenLayer network, not in the in-memory direct-mode VM. Web probes are real: validators query `https://mainnet.base.org` (healthy) and `https://sla-target.uptimesentry.invalid/rpc`. The `.invalid` TLD never resolves (RFC 6761), so every validator observes the same outage.

## What they cover

In file order, against one deployed contract:

1. Deploy, then read the initial protocol state.
2. `register_provider` with 10 GEN, then read back the pool, canonical probe and ledger.
3. Registration failing closed: `ERR_KEYED_ENDPOINT`, `ERR_PROVIDER_EXISTS`, `ERR_ZERO_VALUE`.
4. `purchase_coverage`: quote, premium, and committed capital.
5. `attest_probe`: validators probe the live endpoint and agree on a verdict.
6. `run_sla_drill`: the verdict is consistent with the probe, unbound evidence is rejected, and state is unchanged.
7. Filing failing closed: `ERR_ZERO_BOND`, `ERR_UNBOUND_EVIDENCE`, and no claim created.
8. A live outage: validators agree the `.invalid` target is `UNREACHABLE`.
   - The payout is escrowed and `claim_payout` fails with `ERR_CHALLENGE_WINDOW_OPEN`.
   - An appeal moves the claim to `UNDER_APPEAL`, after which `claim_payout` fails with `ERR_PAYOUT_LOCKED` and `resolve_appeal` fails with `ERR_ADJUDICATION_NOT_READY`.
9. With `UPTIMESENTRY_SLOW=1`: wait out the 5-minute downtime window, `resolve_appeal` confirms the breach (`CONFIRMED`), and `claim_payout` pays out (`PAID`).

Failures are asserted by their exact `ERR_*` code, decoded from the leader receipt, not merely "the transaction failed".

## How to run

```bash
make test-integration                     # Studio Next (studio_devnet), strict
make test-integration NETWORK=localnet    # `genlayer up` (Docker) on :4000
```

Accounts:

- **Default:** the suite uses gltest's generated accounts and asks the network's faucet (`sim_fundAccount`) to fund them. Studio Next honoured that during development.
- **Your own keys:** set `UPTIMESENTRY_TEST_KEYS` to three or more comma-separated private keys. The first is the provider (also appellant and prober), the second the insured holder, the third the reporter.

  | Role | GEN needed |
  | --- | --- |
  | Provider | 35 |
  | Holder | 2 |
  | Reporter | 4 |

  An underfunded role fails the strict run with its address and the missing amount.

Under plain `pytest` or `make test`, these tests **skip with a reason** when no network answers or the accounts can't be funded, so an offline checkout still passes. `make test-integration` sets `UPTIMESENTRY_REQUIRE_NETWORK=1` and turns both conditions into failures.

## GLSim is not supported

The GLSim simulator bundled with `genlayer-test==0.30.0rc2` cannot run this suite:

1. **Calldata envelope.** `genlayer-py==0.19.0rc2` puts the method name under the empty key (`{"": "get_provider", ...}`), but that GLSim reads `{"method": ...}`, so every call fails with `No method in calldata`.
2. **Transaction value.** GLSim records a transaction's value but never passes it to the contract call, so every payable method sees `gl.message.value == 0` (`ERR_ZERO_VALUE`).

Both are simulator limitations, not contract behaviour. Use Studio Next or `genlayer up`.
