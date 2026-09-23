"""Shared constants and helpers for the UptimeSentry direct-mode suite.

Direct mode executes the contract in-process: the leader function of every
consensus probe runs against HTTP responses pinned through the gltest harness
(see `pin_response`), so each test decides exactly what the registered
endpoint answers at each moment of a claim's lifecycle.
"""

import json
from datetime import datetime, timedelta, timezone

CONTRACT = "contracts/uptimesentry.py"

ATTO = 10**18
DAY = 86_400
CHALLENGE_WINDOW = DAY

ENDPOINT = "https://ethereum-rpc.publicnode.com"
PROBE = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
PROBE_CANONICAL = '{"id":1,"jsonrpc":"2.0","method":"eth_blockNumber","params":[]}'
MAX_DOWNTIME = 600
UNDERWRITING = 50 * ATTO
COVERAGE = 5 * ATTO
PREMIUM_BPS = 200
TERM_DAYS = 30
PREMIUM = COVERAGE * PREMIUM_BPS * TERM_DAYS // (10_000 * 30)
REPORTER_BOND = 1 * ATTO
APPEAL_BOND = 2 * ATTO

TRACE = "POST eth_blockNumber -> HTTP 503 Service Unavailable after 3 retries (10s timeout)"

RESOLUTION_WINDOW = 2 * 3600
SAMPLE_INTERVAL = 600
WINDOW_CLOSED = MAX_DOWNTIME + RESOLUTION_WINDOW + 1  # confirmation window closed (seconds after T0)

# LLM answers as a model returns them: JSON inside prose. (The gltest harness
# auto-parses bare JSON mocks into dicts, which the SDK's text channel rejects.)
def llm_answer(category: str, rationale: str) -> str:
    return "Classification: " + json.dumps({"category": category, "rationale": rationale})


TRIAGE_A = llm_answer("A", "The trace describes the provider returning 503 errors.")
TRIAGE_B = llm_answer("B", "The trace describes the reporter's own expired API key.")
TRIAGE_INCONCLUSIVE = llm_answer("INCONCLUSIVE", "The trace does not describe the failure.")

T0 = datetime(2026, 9, 1, tzinfo=timezone.utc)


def hexaddr(addr) -> str:
    return "0x" + bytes(addr).hex()


def at(direct_vm, seconds: int) -> None:
    """Move the transaction clock to T0 + seconds."""
    direct_vm.warp((T0 + timedelta(seconds=seconds)).strftime("%Y-%m-%dT%H:%M:%SZ"))


def call_with_value(direct_vm, value: int, fn, *args):
    direct_vm.value = value
    try:
        return fn(*args)
    finally:
        direct_vm.value = 0


def clear_responses(direct_vm, triage: str = TRIAGE_A) -> None:
    """Drop every pinned response (unpinned URLs behave as unreachable) and pin
    the LLM triage answer the filing step will receive."""
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*incident triage.*", triage)


def pin_response(direct_vm, url: str, method: str, status: int, body: str) -> None:
    """Pin the HTTP response the endpoint at `url` returns to validators."""
    direct_vm.mock_web(rf"^{url}$", {"method": method, "status": status, "body": body})


def endpoint_healthy(direct_vm, url: str = ENDPOINT, triage: str = TRIAGE_A) -> None:
    clear_responses(direct_vm, triage)
    pin_response(direct_vm, url, "POST", 200, json.dumps({"jsonrpc": "2.0", "id": 1, "result": "0x14a8c3f"}))


def endpoint_down(direct_vm, url: str = ENDPOINT, status: int = 503, triage: str = TRIAGE_A) -> None:
    clear_responses(direct_vm, triage)
    pin_response(direct_vm, url, "POST", status, "upstream unavailable")


def endpoint_rpc_error(direct_vm, url: str = ENDPOINT, triage: str = TRIAGE_A) -> None:
    clear_responses(direct_vm, triage)
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "error": {"code": -32000, "message": "header not found"}})
    pin_response(direct_vm, url, "POST", 200, body)


def assert_solvent(contract) -> dict:
    stats = contract.get_protocol_stats()
    assert stats["solvent"], stats
    assert stats["liabilities"] == stats["net_inflow"]
    return stats


class World:
    """A registered provider (alice), an insured subscriber (bob), a reporter
    (charlie) and a watchdog, with one active policy."""

    def __init__(self, direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, watchdog):
        self.vm = direct_vm
        self.provider_owner = direct_alice
        self.holder = direct_bob
        self.reporter = direct_charlie
        self.watchdog = watchdog
        at(direct_vm, 0)
        self.c = direct_deploy(CONTRACT)

        direct_vm.sender = direct_alice
        self.provider_id = call_with_value(
            direct_vm,
            UNDERWRITING,
            self.c.register_provider,
            "PublicNode Ethereum",
            ENDPOINT,
            "JSONRPC",
            PROBE,
            MAX_DOWNTIME,
            9_990,
            PREMIUM_BPS,
        )
        direct_vm.sender = direct_bob
        self.policy_id = call_with_value(
            direct_vm, PREMIUM, self.c.purchase_coverage, self.provider_id, COVERAGE, TERM_DAYS
        )

    def file(self, bond: int = REPORTER_BOND, **overrides) -> str:
        args = {
            "policy_id": self.policy_id,
            "target_provider_id": self.provider_id,
            "target_endpoint_url": ENDPOINT,
            "probe_payload": PROBE,
            "failure_trace": TRACE,
        }
        args.update(overrides)
        self.vm.sender = self.reporter
        return call_with_value(
            self.vm,
            bond,
            self.c.file_incident,
            args["policy_id"],
            args["target_provider_id"],
            args["target_endpoint_url"],
            args["probe_payload"],
            args["failure_trace"],
        )

    def sample(self, claim_id: str, states: str) -> None:
        """Record confirmation samples at 10-minute steps from the start of the
        confirmation window. `states` is a string of 'D' (503) / 'U' (healthy)."""
        self.vm.sender = self.watchdog
        for i, state in enumerate(states):
            at(self.vm, MAX_DOWNTIME + i * SAMPLE_INTERVAL)
            (endpoint_down if state == "D" else endpoint_healthy)(self.vm)
            self.c.confirm_outage(claim_id)

    def appeal(self, claim_id: str, bond: int = APPEAL_BOND, who=None) -> None:
        self.vm.sender = who if who is not None else self.provider_owner
        call_with_value(self.vm, bond, self.c.file_appeal, claim_id)
