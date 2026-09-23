"""Shared network plumbing for scripts/deploy.py and scripts/smoke_test.py."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from eth_account import Account
from genlayer_py import create_client
from genlayer_py.chains import localnet, studio_devnet

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contracts" / "uptimesentry.py"
DEPLOYMENTS = ROOT / "deployments"

NETWORKS = {
    # Studio Next and studio-dev serve the same chain (61997); the deployment
    # record and explorer use studio-next.
    "studio_devnet": {"chain": studio_devnet, "rpc": "https://studio-next.genlayer.com/api", "record": "studio-next.json"},
    "localnet": {"chain": localnet, "rpc": "http://127.0.0.1:4000/api", "record": "localnet.json"},
}

FEE_ESTIMATE_OPTIONS: Any = {
    "leaderTimeunitsAllocation": 100,
    "validatorTimeunitsAllocation": 200,
    "totalMessageFees": 0,
    "rotations": [1],
}


def die(msg: str) -> None:
    print(f"\n✗ {msg}", file=sys.stderr)
    sys.exit(1)


def step(msg: str) -> None:
    print(f"\n▸ {msg}")


def signer() -> Any | None:
    """The account in GENLAYER_PRIVATE_KEY, or None (read-only)."""
    key = os.environ.get("GENLAYER_PRIVATE_KEY", "").strip()
    return Account.from_key(key) if key else None


def client_for(network: str, rpc: str | None, account: Any | None = None):
    if network not in NETWORKS:
        die(f"unknown network {network!r}; choose from {', '.join(NETWORKS)}")
    cfg = NETWORKS[network]
    # genlayer-py requires an account even for reads; reads are unsigned, so a
    # throwaway key stands in on read-only runs.
    return create_client(chain=cfg["chain"], endpoint=rpc or cfg["rpc"], account=account or Account.create())


def record_path(network: str) -> Path:
    return DEPLOYMENTS / NETWORKS[network]["record"]


def load_record(network: str) -> dict:
    p = record_path(network)
    return json.loads(p.read_text()) if p.exists() else {}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def onchain_code(client, address: str) -> str:
    b64 = client.provider.make_request("gen_getContractCode", [address])
    if isinstance(b64, dict):
        b64 = b64.get("result")
    return base64.b64decode(b64).decode("utf-8")


def live_fees(client) -> Any:
    """The consensus fee deposit a fee-charging network requires; None when gasless."""
    try:
        return client.estimate_transaction_fees(FEE_ESTIMATE_OPTIONS) or None
    except Exception:
        return None


def execution_output(receipt: Any) -> str:
    data = receipt.get("consensus_data") or {}
    lr = data.get("leader_receipt")
    lr = (lr[0] if lr else {}) if isinstance(lr, list) else (lr or {})
    out = []
    raw = lr.get("result")
    if isinstance(raw, str):
        try:
            out.append(base64.b64decode(raw, validate=True).decode("utf-8", "replace"))
        except Exception:
            out.append(raw)
    genvm = lr.get("genvm_result") or {}
    out += [str(genvm[k]) for k in ("stderr", "error_description") if genvm.get(k)]
    return " | ".join(x.strip() for x in out if x and x.strip())


def simulate(client, address: str, fn: str, args: list) -> Any:
    """Run a method as a write simulation and return its decoded result.

    Studio Next serves plain reads without executing a method's
    non-deterministic block ("leader_fault nondet_output absent"). A
    simulation runs the method as leader and commits nothing, so methods that
    probe live endpoints (run_sla_drill) are called this way. The node's clock
    is fixed during simulation; time-dependent verdicts must be re-checked.
    """
    from genlayer_py.abi import calldata

    r = client.simulate_write_contract(address=address, function_name=fn, args=args)
    raw = base64.b64decode(r["result"])
    if r.get("execution_result") != "SUCCESS" or not raw or raw[0] != 0:
        raise RuntimeError(f"{fn} simulation failed: {raw[1:].decode('utf-8', 'replace') if raw else r}")
    return calldata.decode(raw[1:])


def status_of(receipt: Any) -> str:
    """Consensus outcome and execution result, e.g. MAJORITY_AGREE / FINISHED_WITH_RETURN."""
    consensus = receipt.get("result_name") or receipt.get("status_name") or "?"
    execution = receipt.get("txExecutionResultName") or receipt.get("tx_execution_result_name") or "?"
    return f"{consensus} / {execution}"
