#!/usr/bin/env python3
"""Build fee-profile.json from real finalized transactions.

gltest's --fee-profile records fee observations while a suite runs. This script
feeds the same collector (gltest.fees.FeeProfileCollector) the finalized
receipts of transactions already on chain, by default every transaction listed
in the deployment record, so the profile is measured from the working
deployment rather than estimated. The frontend and scripts size fee deposits
from these observations; rebuild it when the contract, GenVM or fee policy
changes.

  python scripts/fee_profile.py                    # from deployments/studio-next.json
  python scripts/fee_profile.py --tx deploy=0x... --tx attest_probe=0x...
"""

from __future__ import annotations

import argparse
from pathlib import Path

from gltest.fees.profile import FeeProfileCollector

from sentry_net import ROOT, client_for, die, load_record, step

HEADROOM = 1.25  # gltest's default --fee-profile-headroom


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", default="studio_devnet")
    ap.add_argument("--rpc")
    ap.add_argument("--tx", action="append", default=[], help="method=0xhash (use 'deploy' for the deployment)")
    ap.add_argument("--out", default=str(ROOT / "fee-profile.json"))
    args = ap.parse_args()

    txs: list[tuple[str, str]] = []
    if args.tx:
        for item in args.tx:
            method, _, h = item.partition("=")
            txs.append((method, h))
    else:
        record = load_record(args.network)
        if record.get("deploy_tx"):
            txs.append(("deploy", record["deploy_tx"]))
        for t in (record.get("smoke_test") or {}).get("transactions", []):
            txs.append((t["method"], t["tx"]))
    if not txs:
        die("no transactions to measure")

    client = client_for(args.network, args.rpc)
    collector = FeeProfileCollector()
    step(f"measuring {len(txs)} finalized transactions")
    for method, h in txs:
        receipt = client.wait_for_transaction_receipt(transaction_hash=h, wait_until="finalized", interval=2000, retries=5)
        before = collector.build_profile(network=args.network, headroom=1.0)
        if method == "deploy":
            collector.record_deploy(receipt)
        else:
            collector.record_method(method, receipt)
        after = collector.build_profile(network=args.network, headroom=1.0)
        changed = {k: v for k, v in after.items() if k != "measuredAt"} != {k: v for k, v in before.items() if k != "measuredAt"}
        print(f"  {method:<22} {h}  {'measured' if changed else 'no new fee observation'}")
    if not collector.has_observations():
        die("no receipt carried fee accounting; nothing to write")

    chain_id = client.w3.eth.chain_id
    profile = collector.write(Path(args.out), network=args.network, headroom=HEADROOM, chain_id=chain_id)
    step(f"wrote {Path(args.out).relative_to(ROOT)} ({len(profile['methods'])} methods{', deploy' if 'deploy' in profile else ''}, headroom {HEADROOM}x)")


if __name__ == "__main__":
    main()
