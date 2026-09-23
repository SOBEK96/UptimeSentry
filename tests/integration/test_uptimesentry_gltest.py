"""UptimeSentry under full leader + validator consensus (gltest).

Runs in file order against one deployed contract per module:
deploy -> register providers -> buy coverage -> consensus probes and drills ->
fail-closed filings -> a live outage claim whose payout is escrowed and then
locked by an appeal. The slow ruling step (the contract's minimum downtime
window is 5 minutes of real time) runs with UPTIMESENTRY_SLOW=1.
"""

import os
import time

import pytest
from gltest.assertions import tx_execution_succeeded

from sentry_client import ATTO, DOWN_ENDPOINT, HEALTHY_ENDPOINT, PROBE, PROBE_CANONICAL

UNDERWRITING = 10 * ATTO  # the contract minimum, to keep live runs cheap
COVERAGE = 5 * ATTO
MAX_DOWNTIME = 300
STATE: dict = {}


def _providers(sentry) -> dict:
    return {p["endpoint_url"]: p for p in sentry.read("list_providers", [0, 50])}


def _addr(account) -> str:
    return account.address.lower()


def test_deploy_initial_state(sentry):
    stats = sentry.read("get_protocol_stats")
    assert stats["providers"] == 0 and stats["policies"] == 0 and stats["claims"] == 0
    assert stats["solvent"] is True
    assert stats["min_underwriting"] == 10 * ATTO


def test_register_provider_and_read_back(sentry, accounts):
    receipt = sentry.write(
        "register_provider",
        ["Base Mainnet Public RPC", HEALTHY_ENDPOINT, "JSONRPC", PROBE, MAX_DOWNTIME, 9_990, 200],
        value=UNDERWRITING,
        account=accounts["provider"],
    )
    assert tx_execution_succeeded(receipt)

    p = _providers(sentry)[HEALTHY_ENDPOINT]
    STATE["healthy_id"] = p["provider_id"]
    assert p["owner"] == _addr(accounts["provider"])
    assert p["probe_payload"] == PROBE_CANONICAL
    assert p["free_capital"] == UNDERWRITING
    assert p["max_downtime_s"] == MAX_DOWNTIME
    assert p["observed_availability_bps"] == -1

    stats = sentry.read("get_protocol_stats")
    assert stats["total_underwriting"] == UNDERWRITING
    assert stats["liabilities"] == stats["net_inflow"] == UNDERWRITING


def test_registration_fails_closed(sentry, accounts):
    args = ["Keyed", "https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161", "JSONRPC", PROBE, 600, 9_990, 200]
    sentry.expect_error("ERR_KEYED_ENDPOINT", "register_provider", args, value=UNDERWRITING, account=accounts["provider"])
    dup = ["Dup", HEALTHY_ENDPOINT, "JSONRPC", PROBE, 600, 9_990, 200]
    sentry.expect_error("ERR_PROVIDER_EXISTS", "register_provider", dup, value=UNDERWRITING, account=accounts["provider"])
    zero = ["Zero", "https://rpc.ankr.com/eth", "JSONRPC", PROBE, 600, 9_990, 200]
    sentry.expect_error("ERR_ZERO_VALUE", "register_provider", zero, value=0, account=accounts["provider"])
    assert sentry.read("get_protocol_stats")["providers"] == 1


def test_purchase_coverage(sentry, accounts):
    premium = sentry.read("quote_premium", [STATE["healthy_id"], COVERAGE, 30])
    assert premium == COVERAGE * 200 * 30 // (10_000 * 30)
    receipt = sentry.write("purchase_coverage", [STATE["healthy_id"], COVERAGE, 30], value=premium, account=accounts["holder"])
    assert tx_execution_succeeded(receipt)
    policy = sentry.read("list_policies", [0, 50])[-1]
    STATE["healthy_policy"] = policy["policy_id"]
    assert policy["holder"] == _addr(accounts["holder"])
    assert policy["coverage"] == COVERAGE and policy["status"] == "ACTIVE"

    p = _providers(sentry)[HEALTHY_ENDPOINT]
    assert p["committed_capital"] == COVERAGE
    assert p["free_capital"] == UNDERWRITING - COVERAGE + premium


def test_attest_probe_reaches_consensus_on_live_endpoint(sentry, accounts):
    receipt = sentry.write("attest_probe", [STATE["healthy_id"]], account=accounts["watchdog"])
    assert tx_execution_succeeded(receipt)
    p = _providers(sentry)[HEALTHY_ENDPOINT]
    assert p["probes_total"] == 1
    # Validators agreed on a verdict; the recorded code must be consistent with it.
    assert (p["probes_up"] == 1) == (p["last_probe_code"] == "UP")


def test_drill_is_read_only_and_binding_aware(sentry):
    # Called as a write simulation: plain reads on Studio Next skip the drill's
    # non-deterministic probe ("leader_fault nondet_output absent").
    before = sentry.read("get_protocol_stats")
    bound = sentry.simulate("run_sla_drill", [STATE["healthy_policy"], STATE["healthy_id"], HEALTHY_ENDPOINT, PROBE])
    assert bound["bound"] is True
    expected = "REJECTED_TARGET_HEALTHY" if bound["observed_up"] else "CLAIM_WOULD_BE_ACCEPTED"
    assert bound["verdict"] == expected

    unbound = sentry.simulate("run_sla_drill", [STATE["healthy_policy"], STATE["healthy_id"], "https://rpc.ankr.com/eth", PROBE])
    assert unbound["bound"] is False and unbound["verdict"] == "REJECTED_UNBOUND_EVIDENCE"
    assert sentry.read("get_protocol_stats") == before


def test_filing_fails_closed(sentry, accounts):
    pol, pid = STATE["healthy_policy"], STATE["healthy_id"]
    trace = "POST eth_blockNumber -> HTTP 503"
    sentry.expect_error("ERR_ZERO_BOND", "file_incident", [pol, pid, HEALTHY_ENDPOINT, PROBE, trace], value=0, account=accounts["reporter"])
    sentry.expect_error(
        "ERR_UNBOUND_EVIDENCE",
        "file_incident",
        [pol, pid, "https://rpc.ankr.com/eth", PROBE, trace],
        value=ATTO,
        account=accounts["reporter"],
    )
    assert sentry.read("get_protocol_stats")["claims"] == 0


def test_outage_claim_escrows_and_locks_under_appeal(sentry, accounts):
    # A permanently unreachable target, underwritten and insured.
    reg = sentry.write(
        "register_provider",
        ["Unreachable RPC", DOWN_ENDPOINT, "JSONRPC", PROBE, MAX_DOWNTIME, 9_990, 200],
        value=UNDERWRITING,
        account=accounts["provider"],
    )
    assert tx_execution_succeeded(reg)
    down_id = _providers(sentry)[DOWN_ENDPOINT]["provider_id"]
    premium = sentry.read("quote_premium", [down_id, COVERAGE, 7])
    assert tx_execution_succeeded(sentry.write("purchase_coverage", [down_id, COVERAGE, 7], value=premium, account=accounts["holder"]))
    policy = sentry.read("list_policies", [0, 50])[-1]["policy_id"]

    # Validators independently fail to reach it and agree it is down.
    filed = sentry.write(
        "file_incident",
        [policy, down_id, DOWN_ENDPOINT, PROBE, "POST eth_blockNumber -> DNS resolution failure"],
        value=ATTO,
        account=accounts["reporter"],
    )
    assert tx_execution_succeeded(filed)
    claim = sentry.read("list_claims", [0, 50])[-1]
    STATE.update(down_claim=claim["claim_id"], down_id=down_id)
    assert claim["status"] == "CLAIM_PENDING"
    assert claim["filing_probe_code"] == "UNREACHABLE"
    assert claim["payout"] == COVERAGE
    stats = sentry.read("get_protocol_stats")
    assert stats["total_escrow"] == COVERAGE and stats["solvent"] is True

    sentry.expect_error("ERR_CHALLENGE_WINDOW_OPEN", "claim_payout", [claim["claim_id"]], account=accounts["holder"])

    bond = sentry.read("required_appeal_bond", [claim["claim_id"]])
    assert tx_execution_succeeded(sentry.write("file_appeal", [claim["claim_id"]], value=bond, account=accounts["provider"]))
    assert sentry.read("get_claim", [claim["claim_id"]])["status"] == "UNDER_APPEAL"
    sentry.expect_error("ERR_PAYOUT_LOCKED", "claim_payout", [claim["claim_id"]], account=accounts["holder"])
    sentry.expect_error("ERR_ADJUDICATION_NOT_READY", "resolve_appeal", [claim["claim_id"]], account=accounts["watchdog"])
    assert sentry.read("get_protocol_stats")["solvent"] is True


@pytest.mark.skipif(os.environ.get("UPTIMESENTRY_SLOW") != "1", reason="waits out the 5-minute downtime window; set UPTIMESENTRY_SLOW=1")
def test_appeal_ruling_confirms_sustained_outage(sentry, accounts):
    claim_id = STATE["down_claim"]
    wait = sentry.read("get_claim", [claim_id])["confirm_after"] - int(time.time()) + 5
    if wait > 0:
        time.sleep(wait)
    assert tx_execution_succeeded(sentry.write("resolve_appeal", [claim_id], account=accounts["watchdog"]))
    claim = sentry.read("get_claim", [claim_id])
    assert claim["status"] == "CONFIRMED" and claim["ruling_probe_code"] == "UNREACHABLE"
    assert tx_execution_succeeded(sentry.write("claim_payout", [claim_id], account=accounts["watchdog"]))
    assert sentry.read("get_claim", [claim_id])["status"] == "PAID"
    assert sentry.read("get_protocol_stats")["solvent"] is True
