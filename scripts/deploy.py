#!/usr/bin/env python3
"""Deploy contracts/uptimesentry.py and record the deployment.

The lifecycle, in order:
  1. preflight   genvm-lint lint + validate must pass with no errors
  2. source      sha256 of the exact bytes that will be deployed
  3. network     connect, read the chain id, check the deployer's balance
  4. fees        quote the consensus fee deposit (fee-charging networks reject
                 a zero deposit with FeeValueMustBeNonZero)
  5. deploy      submit, then wait for finalization, not just acceptance
  6. verify      re-download the on-chain source and compare its sha256;
                 read get_protocol_stats to prove the constructor ran
  7. record      write deployments/<network>.json for the frontend and scripts

  python scripts/deploy.py --dry-run                     # steps 1-4, no signing
  GENLAYER_PRIVATE_KEY=0x... python scripts/deploy.py    # full deploy (Studio Next)
  ... --network localnet                                 # `genlayer up` on :4000

An existing record is never overwritten without --force.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
from pathlib import Path

from sentry_net import (
    CONTRACT,
    NETWORKS,
    client_for,
    die,
    live_fees,
    onchain_code,
    record_path,
    sha256_text,
    signer,
    status_of,
    step,
)

RUNNER = "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng"
EXPLORERS = {"studio_devnet": "https://explorer-studio-next.genlayer.com"}


def preflight() -> None:
    lint = shutil.which("genvm-lint")
    if not lint:
        die("genvm-lint not found; run `make install`")
    for cmd in ("lint", "validate"):
        res = subprocess.run([lint, cmd, str(CONTRACT)], capture_output=True, text=True)
        tail = (res.stdout + res.stderr).strip().splitlines()
        print(f"  genvm-lint {cmd}: {tail[-1] if tail else ''}")
        if res.returncode != 0:
            die(f"genvm-lint {cmd} failed:\n" + "\n".join(tail))


def contract_address(receipt: dict) -> str | None:
    data = receipt.get("data") or {}
    return data.get("contract_address") or receipt.get("recipient") or receipt.get("to_address")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--network", default="studio_devnet", choices=list(NETWORKS))
    ap.add_argument("--rpc", help="RPC override")
    ap.add_argument("--dry-run", action="store_true", help="stop before signing")
    ap.add_argument("--force", action="store_true", help="overwrite an existing deployments record")
    ap.add_argument("--out", help="write the record here instead of deployments/<network>.json")
    args = ap.parse_args()

    step("1. preflight")
    preflight()

    step("2. source")
    source = CONTRACT.read_text()
    source_sha = sha256_text(source)
    print(f"  {CONTRACT.relative_to(CONTRACT.parent.parent)}  sha256 {source_sha}")

    step(f"3. network {args.network}")
    account = signer()
    if account is None and not args.dry_run:
        die("GENLAYER_PRIVATE_KEY is not set (use --dry-run to check everything else)")
    client = client_for(args.network, args.rpc, account)
    chain_id = client.w3.eth.chain_id
    print(f"  chain id {chain_id}")
    if account is not None:
        balance = client.w3.eth.get_balance(account.address)
        print(f"  deployer {account.address}  balance {balance / 10**18:.4f} GEN")
    else:
        print("  deployer: none (dry run)")

    step("4. fees")
    fees = live_fees(client)
    fee_value = int((fees or {}).get("feeValue", (fees or {}).get("fee_value", 0)) or 0)
    print(f"  fee deposit {fee_value / 10**18:.6f} GEN" if fees else "  gasless network: no fee deposit")

    record_file = Path(args.out).resolve() if args.out else record_path(args.network)
    if record_file.exists() and not args.force:
        print(f"  note: {record_file} exists; a real deploy needs --force to replace it")
    if args.dry_run:
        print("\n✓ dry run complete: nothing was signed or sent")
        return
    if record_file.exists() and not args.force:
        die(f"{record_file} already records a deployment; pass --force to replace it")

    step("5. deploy")
    tx_hash = client.deploy_contract(code=source, account=account, args=[], fees=fees)
    print(f"  tx {tx_hash}")
    receipt = client.wait_for_transaction_receipt(transaction_hash=tx_hash, wait_until="finalized", interval=4000, retries=90)
    address = contract_address(receipt)
    print(f"  status {status_of(receipt)}  address {address}")
    if not address:
        die("the receipt carries no contract address")

    step("6. verify")
    onchain_sha = sha256_text(onchain_code(client, address))
    if onchain_sha != source_sha:
        die(f"on-chain source sha256 {onchain_sha} differs from local {source_sha}")
    print("  ✓ on-chain source matches")
    stats = client.read_contract(address=address, function_name="get_protocol_stats", args=[])
    if not stats.get("solvent"):
        die("constructor state is not solvent")
    print("  ✓ constructor ran: empty, solvent ledger")

    step("7. record")
    explorer = EXPLORERS.get(args.network)
    record = {
        "network": "studio-next" if args.network == "studio_devnet" else args.network,
        "chain_id": chain_id,
        "rpc_url": args.rpc or NETWORKS[args.network]["rpc"],
        **({"explorer_url": f"{explorer}/address/{address}"} if explorer else {}),
        "contract_address": address,
        "deploy_tx": str(tx_hash),
        "deployer": account.address,
        "deployed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "contracts/uptimesentry.py",
        "source_sha256": source_sha,
        "onchain_code_sha256": onchain_sha,
        "runner": RUNNER,
    }
    record_file.parent.mkdir(exist_ok=True)
    record_file.write_text(json.dumps(record, indent=2) + "\n")
    print(f"  wrote {record_file}")
    print(f"\n✓ deployed {address}\n  set VITE_UPTIMESENTRY_ADDRESS={address} in frontend/.env")


if __name__ == "__main__":
    main()
