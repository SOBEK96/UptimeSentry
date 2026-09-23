#!/usr/bin/env python3
"""Seed a deployed UptimeSentry contract with live, consensus-verified activity.

  1. register_provider  the endpoint, backed by an underwriting pool (native GEN)
  2. purchase_coverage  a small policy from a second account (enables the drill)
  3. attest_probe       validators probe the endpoint and record the verdict
  4. run_sla_drill      write simulation: live probe in GenVM, nothing committed

Each write waits for finalization and prints its hash, consensus result and
execution result. Steps already done (provider registered, policy held) are
skipped, so the script is safe to re-run.

Keys: PROVIDER_PRIVATE_KEY and HOLDER_PRIVATE_KEY (hex). On Studio networks
--fund asks the network faucet to top the two accounts up first.

  PROVIDER_PRIVATE_KEY=0x.. HOLDER_PRIVATE_KEY=0x.. \\
    python scripts/bootstrap_live.py --endpoint https://mainnet.base.org --fund
"""

from __future__ import annotations

import argparse
import os
import time

from eth_account import Account

from sentry_net import client_for, die, live_fees, load_record, simulate, status_of, step

ATTO = 10**18
PROBE = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
EXPLORER = "https://explorer-studio-next.genlayer.com"


def key(name: str):
    raw = os.environ.get(name, "").strip()
    if not raw:
        die(f"{name} is not set")
    return Account.from_key(raw)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", default="studio_devnet")
    ap.add_argument("--rpc")
    ap.add_argument("--contract", help="default: deployments record")
    ap.add_argument("--endpoint", default="https://mainnet.base.org")
    ap.add_argument("--name", default="Base Mainnet Public RPC")
    ap.add_argument("--pool", type=float, default=10.0, help="underwriting pool in GEN (min 10)")
    ap.add_argument("--coverage", type=float, default=1.0, help="policy coverage in GEN (min 1)")
    ap.add_argument("--fund", action="store_true", help="top up both accounts from the Studio faucet")
    args = ap.parse_args()

    address = args.contract or load_record(args.network).get("contract_address")
    if not address:
        die("no contract address")
    provider, holder = key("PROVIDER_PRIVATE_KEY"), key("HOLDER_PRIVATE_KEY")
    c = client_for(args.network, args.rpc, provider)
    fees = live_fees(c)
    hashes: list[tuple[str, str]] = []

    def write(fn: str, fn_args: list, account, value: int = 0) -> dict:
        h = c.write_contract(address=address, function_name=fn, account=account, args=fn_args, value=value, fees=fees)
        r = c.wait_for_transaction_receipt(transaction_hash=h, wait_until="finalized", interval=4000, retries=120)
        print(f"  {fn:<18} {h}  {status_of(r)}")
        hashes.append((fn, str(h)))
        if r.get("txExecutionResultName") != "FINISHED_WITH_RETURN":
            die(f"{fn} did not execute successfully")
        return r

    if args.fund:
        step("faucet")
        for a in (provider, holder):
            c.provider.make_request("sim_fundAccount", [a.address, 30 * ATTO])
        time.sleep(8)
    for label, a in (("provider", provider), ("holder", holder)):
        print(f"  {label:<8} {a.address}  {c.w3.eth.get_balance(a.address) / ATTO:.4f} GEN")

    step(f"1. register_provider {args.endpoint}")
    existing = {p["endpoint_url"]: p for p in c.read_contract(address=address, function_name="list_providers", args=[0, 50])}
    if args.endpoint in existing:
        print("  already registered, skipping")
    else:
        write("register_provider", [args.name, args.endpoint, "JSONRPC", PROBE, 600, 9_990, 200], provider, int(args.pool * ATTO))
        existing = {p["endpoint_url"]: p for p in c.read_contract(address=address, function_name="list_providers", args=[0, 50])}
    p = existing[args.endpoint]
    print(f"  provider_id {p['provider_id']}  pool {(p['free_capital'] + p['committed_capital']) / ATTO:.4f} GEN")

    step("2. purchase_coverage")
    policies = [x for x in c.read_contract(address=address, function_name="list_policies", args=[0, 50]) if x["provider_id"] == p["provider_id"] and x["status"] == "ACTIVE"]
    if policies:
        print(f"  active policy {policies[0]['policy_id']} exists, skipping")
    else:
        cov = int(args.coverage * ATTO)
        premium = c.read_contract(address=address, function_name="quote_premium", args=[p["provider_id"], cov, 30])
        write("purchase_coverage", [p["provider_id"], cov, 30], holder, premium)
        policies = [x for x in c.read_contract(address=address, function_name="list_policies", args=[0, 50]) if x["provider_id"] == p["provider_id"] and x["status"] == "ACTIVE"]
    policy = policies[0]

    step("3. attest_probe (validator consensus)")
    before = p["probes_total"]
    write("attest_probe", [p["provider_id"]], provider)
    p = next(x for x in c.read_contract(address=address, function_name="list_providers", args=[0, 50]) if x["provider_id"] == p["provider_id"])
    print(f"  recorded {p['last_probe_code']} · probes {before} -> {p['probes_total']} · uptime {p['observed_availability_bps'] / 100:.2f}%")

    step("4. run_sla_drill (simulation, nothing committed)")
    d = simulate(c, address, "run_sla_drill", [policy["policy_id"], p["provider_id"], p["endpoint_url"], p["probe_payload"]])
    print(f"  {d['verdict']} · live probe {d['state']} ({d['code']})")

    stats = c.read_contract(address=address, function_name="get_protocol_stats", args=[])
    step("ledger")
    print(f"  underwriting {stats['total_underwriting'] / ATTO:.4f} GEN · liabilities == net inflow: {stats['solvent']}")
    print("\nTransactions:")
    for fn, h in hashes:
        print(f"  {fn:<18} {EXPLORER}/tx/{h}")


if __name__ == "__main__":
    main()
