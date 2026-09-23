"""Schema-free client for driving a deployed UptimeSentry contract through
full leader + validator consensus (genlayer_py, by function name)."""

import base64
import os
from typing import Any

from gltest.clients import get_gl_client
from gltest.fees import maybe_record_fee_observation

ATTO = 10**18

# Public, keyless JSON-RPC endpoint that validators can reach. Used for the
# healthy-target path.
HEALTHY_ENDPOINT = "https://mainnet.base.org"
PROBE = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
PROBE_CANONICAL = '{"id":1,"jsonrpc":"2.0","method":"eth_blockNumber","params":[]}'
# The reserved .invalid TLD (RFC 6761) never resolves, so every validator
# observes the same transport failure: a permanently down, keyless target.
DOWN_ENDPOINT = "https://sla-target.uptimesentry.invalid/rpc"

# Receipt polling budget: a non-deterministic round on a loaded network can
# outlast genlayer-py's defaults, which would report a still-pending
# transaction as a failure.
WAIT_INTERVAL_MS = int(os.environ.get("UPTIMESENTRY_WAIT_INTERVAL_MS", "3000"))
WAIT_RETRIES = int(os.environ.get("UPTIMESENTRY_WAIT_RETRIES", "120"))

# A fee-charging network (Studio Devnet) rejects writes that carry no fee
# distribution and value (FeeValueMustBeNonZero). Gasless networks answer the
# estimate with nothing useful, and submitting no fees is correct there.
FEE_ESTIMATE_OPTIONS: Any = {
    "leaderTimeunitsAllocation": 100,
    "validatorTimeunitsAllocation": 200,
    "totalMessageFees": 0,
    "rotations": [1],
}
_fees: dict = {}


def live_fees() -> Any:
    if "value" not in _fees:
        try:
            _fees["value"] = get_gl_client().estimate_transaction_fees(FEE_ESTIMATE_OPTIONS) or {}
        except Exception:
            _fees["value"] = {}
    return _fees["value"] or None


def _leader_receipt(receipt: Any) -> dict:
    data = receipt.get("consensus_data") or {}
    lr = data.get("leader_receipt")
    if isinstance(lr, list):
        lr = lr[0] if lr else {}
    return lr if isinstance(lr, dict) else {}


def execution_output(receipt: Any) -> str:
    """The leader's return/error payload as text (contract UserError messages
    travel here, not on stderr)."""
    lr = _leader_receipt(receipt)
    parts = []
    raw = lr.get("result")
    if isinstance(raw, dict):
        raw = raw.get("raw") or raw.get("payload") or str(raw)
    if isinstance(raw, str):
        try:
            parts.append(base64.b64decode(raw, validate=True).decode("utf-8", "replace"))
        except Exception:
            parts.append(raw)
    genvm = lr.get("genvm_result") or {}
    for key in ("stderr", "stdout", "error_description", "raw_error"):
        if genvm.get(key):
            parts.append(str(genvm[key]))
    return "\n".join(parts)


class SentryClient:
    def __init__(self, address: str):
        self.address = address
        self.client = get_gl_client()

    def read(self, fn: str, args: list | None = None) -> Any:
        return self.client.read_contract(address=self.address, function_name=fn, args=args or [])

    def simulate(self, fn: str, args: list | None = None) -> Any:
        """Run a method as a write simulation (leader mode, nothing committed).
        Plain reads on Studio Next skip non-deterministic blocks, so methods that
        probe live endpoints are called this way."""
        from genlayer_py.abi import calldata

        r = self.client.simulate_write_contract(address=self.address, function_name=fn, args=args or [])
        raw = base64.b64decode(r["result"])
        assert r.get("execution_result") == "SUCCESS" and raw and raw[0] == 0, f"{fn} simulation failed: {raw[1:]!r}"
        return calldata.decode(raw[1:])

    def write(self, fn: str, args: list | None = None, value: int = 0, account=None) -> Any:
        tx_hash = self.client.write_contract(
            address=self.address,
            function_name=fn,
            account=account,
            args=args or [],
            value=value,
            fees=live_fees(),
        )
        receipt = self.client.wait_for_transaction_receipt(
            transaction_hash=tx_hash,
            wait_until="finalized",
            interval=WAIT_INTERVAL_MS,
            retries=WAIT_RETRIES,
        )
        maybe_record_fee_observation(kind="method", method_name=fn, receipt=receipt)
        return receipt

    def expect_error(self, code: str, fn: str, args: list | None = None, value: int = 0, account=None) -> str:
        """Submit a write that must fail closed with `code`. Returns the error text."""
        from gltest.assertions import tx_execution_failed

        receipt = self.write(fn, args=args, value=value, account=account)
        assert tx_execution_failed(receipt), f"{fn} unexpectedly succeeded"
        out = execution_output(receipt)
        assert code in out, f"{fn} failed without {code}: {out[:300]!r}"
        return out
