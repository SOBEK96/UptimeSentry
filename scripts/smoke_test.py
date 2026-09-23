#!/usr/bin/env python3
"""Live smoke test for a deployed UptimeSentry contract.

Read-only by default (no key needed):
  1. network reachable and on the recorded chain
  2. on-chain source is byte-identical to contracts/uptimesentry.py
  3. protocol ledger is solvent (liabilities == deposits - withdrawals)
  4. every provider readable; each policy on the target drilled via run_sla_drill
     (as a write simulation: live probe in GenVM, nothing committed)

With --write and GENLAYER_PRIVATE_KEY set, it also submits attest_probe (a
consensus probe of the provider's endpoint, fee deposit only, no value) and
prints the transaction hash and final status.

  python scripts/smoke_test.py                         # Studio Next, read-only
  GENLAYER_PRIVATE_KEY=0x... python scripts/smoke_test.py --write
"""

from __future__ import annotations

import argparse
import time

from sentry_net import (
    CONTRACT,
    client_for,
    die,
    execution_output,
    live_fees,
    load_record,
    onchain_code,
    sha256_text,
    signer,
    simulate,
    status_of,
    step,
)


def gen(v: int) -> str:
    return f"{v / 10**18:,.4f} GEN"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", default="studio_devnet")
    ap.add_argument("--rpc", help="RPC override")
    ap.add_argument("--contract", help="contract address (default: deployments record)")
    ap.add_argument("--provider", help="provider id to probe (default: first registered)")
    ap.add_argument("--write", action="store_true", help="also submit attest_probe (needs GENLAYER_PRIVATE_KEY)")
    args = ap.parse_args()

    record = load_record(args.network)
    address = args.contract or record.get("contract_address")
    if not address:
        die("no contract address: pass --contract or add a deployments record")
    account = signer()
    client = client_for(args.network, args.rpc, account)
    failures = 0

    step(f"network {args.network}")
    chain_id = client.w3.eth.chain_id
    expected = record.get("chain_id")
    print(f"  chain id {chain_id}" + (f" (recorded {expected})" if expected else ""))
    if expected and chain_id != expected:
        die("connected to a different chain than the deployment record")

    step(f"contract {address}")
    code_hash = sha256_text(onchain_code(client, address))
    local_hash = sha256_text(CONTRACT.read_text())
    print(f"  on-chain sha256 {code_hash}")
    print(f"  local    sha256 {local_hash}")
    if code_hash == local_hash:
        print("  ✓ deployed source matches contracts/uptimesentry.py")
    else:
        print("  ! deployed source differs from contracts/uptimesentry.py")
        failures += 1

    step("protocol ledger")
    stats = client.read_contract(address=address, function_name="get_protocol_stats", args=[])
    print(f"  providers {stats['providers']} · policies {stats['policies']} · claims {stats['claims']}")
    print(f"  underwriting {gen(stats['total_underwriting'])} · escrow {gen(stats['total_escrow'])} · bonds {gen(stats['total_bonds'])}")
    print(f"  liabilities {gen(stats['liabilities'])} · net inflow {gen(stats['net_inflow'])}")
    if stats["solvent"]:
        print("  ✓ ledger balanced")
    else:
        print("  ✗ ledger mismatch")
        failures += 1

    providers = client.read_contract(address=address, function_name="list_providers", args=[0, 50])
    policies = client.read_contract(address=address, function_name="list_policies", args=[0, 50])
    if not providers:
        die("no providers registered; nothing to smoke-test")
    step("providers")
    for p in providers:
        uptime = "no probes yet" if p["probes_total"] == 0 else f"{p['observed_availability_bps'] / 100:.2f}% over {p['probes_total']} probes, last {p['last_probe_code']}"
        print(f"  {p['provider_id']}  {p['name']}  {p['endpoint_url']}")
        print(f"    pool {gen(p['free_capital'] + p['committed_capital'])} · uptime {uptime}")

    target = next((p for p in providers if p["provider_id"] == args.provider), None) if args.provider else providers[0]
    if target is None:
        die(f"provider {args.provider} not found")

    step(f"run_sla_drill on {target['name']}")
    mine = [pol for pol in policies if pol["provider_id"] == target["provider_id"]]
    if not mine:
        print("  - skipped: the drill runs against a policy and this endpoint has none yet")
    for pol in mine:
        d = simulate(client, address, "run_sla_drill", [pol["policy_id"], target["provider_id"], target["endpoint_url"], target["probe_payload"]])
        verdict = d["verdict"]
        if pol["expires_at"] <= time.time() and verdict != "REJECTED_POLICY_NOT_ACTIVE":
            verdict = "REJECTED_POLICY_NOT_ACTIVE"  # simulation clock is fixed; expiry re-checked in real time
        print(f"  policy {pol['policy_id']}: {verdict} (live probe {d['code'] or '-'})")

    if args.write:
        step(f"attest_probe on {target['name']}")
        if account is None:
            die("--write needs GENLAYER_PRIVATE_KEY")
        before = target["probes_total"]
        tx_hash = client.write_contract(
            address=address,
            function_name="attest_probe",
            account=account,
            args=[target["provider_id"]],
            fees=live_fees(client),
        )
        print(f"  tx {tx_hash}")
        receipt = client.wait_for_transaction_receipt(transaction_hash=tx_hash, wait_until="finalized", interval=4000, retries=90)
        print(f"  status {status_of(receipt)}")
        after = next(p for p in client.read_contract(address=address, function_name="list_providers", args=[0, 50]) if p["provider_id"] == target["provider_id"])
        if after["probes_total"] == before + 1:
            print(f"  ✓ recorded: {after['last_probe_code']} at {time.strftime('%Y-%m-%d %H:%M:%SZ', time.gmtime(after['last_probe_at']))}")
        else:
            print(f"  ✗ not recorded: {execution_output(receipt) or 'no error payload'}")
            failures += 1
    else:
        step("attest_probe")
        print("  - skipped (read-only run; pass --write with GENLAYER_PRIVATE_KEY to submit)")

    print("\n" + ("✓ smoke test passed" if failures == 0 else f"✗ smoke test found {failures} problem(s)"))
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
