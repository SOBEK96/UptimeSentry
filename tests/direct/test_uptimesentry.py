"""Core lifecycle and fail-closed guarantees of the UptimeSentry protocol."""

from sentry_helpers import (
    APPEAL_BOND,
    CHALLENGE_WINDOW,
    COVERAGE,
    ENDPOINT,
    MAX_DOWNTIME,
    PREMIUM,
    PROBE,
    REPORTER_BOND,
    WINDOW_CLOSED,
    UNDERWRITING,
    assert_solvent,
    at,
    call_with_value,
    clear_responses,
    endpoint_down,
    endpoint_healthy,
    endpoint_rpc_error,
    hexaddr,
    pin_response,
)

SLASH = COVERAGE * 2_000 // 10_000
REPORTER_SHARE = SLASH // 2


# --- the six required guarantees ----------------------------------------------


def test_reject_zero_bond_claim(world):
    endpoint_down(world.vm)
    with world.vm.expect_revert("ERR_ZERO_BOND"):
        world.file(bond=0)
    assert world.c.get_protocol_stats()["claims"] == 0
    assert world.c.get_policy(world.policy_id)["status"] == "ACTIVE"

    # An appeal without a native bond is rejected just the same.
    claim_id = world.file()
    with world.vm.expect_revert("ERR_ZERO_BOND"):
        world.appeal(claim_id, bond=0)
    assert world.c.get_claim(claim_id)["status"] == "CLAIM_PENDING"


def test_reject_unbound_endpoint_evidence(world):
    endpoint_down(world.vm)
    endpoint_down(world.vm, "https://rpc.ankr.com/eth")
    msg = "ERR_UNBOUND_EVIDENCE: incident telemetry does not match registered target"

    # Telemetry aimed at a different endpoint than the one underwritten.
    with world.vm.expect_revert(msg):
        world.file(target_endpoint_url="https://rpc.ankr.com/eth")
    # A trailing slash is a different target: the match is exact.
    with world.vm.expect_revert(msg):
        world.file(target_endpoint_url=ENDPOINT + "/")
    # Evidence naming another provider id.
    with world.vm.expect_revert(msg):
        world.file(target_provider_id="0x" + "ab" * 20)
    # A different query payload than the registered probe.
    with world.vm.expect_revert(msg):
        world.file(probe_payload='{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}')
    # An unparseable payload is unbound too, not a different error class.
    with world.vm.expect_revert(msg):
        world.file(probe_payload="eth_blockNumber")

    assert world.c.get_protocol_stats()["claims"] == 0
    assert_solvent(world.c)


def test_payout_locked_during_appeal(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    world.appeal(claim_id)
    assert world.c.get_claim(claim_id)["status"] == "UNDER_APPEAL"

    # Locked for every caller and at every point in time until the ruling,
    # including after the original challenge window has closed.
    for who in (world.holder, world.reporter, world.watchdog):
        world.vm.sender = who
        with world.vm.expect_revert("ERR_PAYOUT_LOCKED: funds preserved until appeal resolution"):
            world.c.claim_payout(claim_id)
    at(world.vm, CHALLENGE_WINDOW + 1)
    world.vm.sender = world.holder
    with world.vm.expect_revert("ERR_PAYOUT_LOCKED: funds preserved until appeal resolution"):
        world.c.claim_payout(claim_id)

    stats = assert_solvent(world.c)
    assert stats["total_escrow"] == COVERAGE
    assert stats["total_withdrawn"] == 0


def test_fraudulent_claim_slashing(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    world.appeal(claim_id)
    pool_before = world.c.get_provider(world.provider_id)

    # The target is healthy throughout the confirmation window: the outage
    # never breached the SLA, so the claim is dismissed.
    world.sample(claim_id, "UUU")
    at(world.vm, WINDOW_CLOSED)
    world.vm.sender = world.watchdog
    assert world.c.resolve_appeal(claim_id) == "DISMISSED"

    claim = world.c.get_claim(claim_id)
    provider = world.c.get_provider(world.provider_id)
    assert claim["ruling_probe_code"] == "0/3 DOWN"
    # Reporter bond slashed into the provider's pool, escrow back to backing
    # the still-active policy.
    assert provider["free_capital"] == pool_before["free_capital"] + REPORTER_BOND
    assert provider["committed_capital"] == pool_before["committed_capital"] + COVERAGE
    assert provider["incidents_dismissed"] == 1
    assert provider["open_claims"] == 0
    assert world.c.get_policy(world.policy_id)["status"] == "ACTIVE"
    # Reporter gets nothing back; appellant is refunded in full.
    assert world.c.claimable_of(hexaddr(world.reporter)) == 0
    assert world.c.claimable_of(hexaddr(world.provider_owner)) == APPEAL_BOND

    world.vm.sender = world.holder
    with world.vm.expect_revert("ERR_CLAIM_DISMISSED"):
        world.c.claim_payout(claim_id)
    world.vm.sender = world.reporter
    with world.vm.expect_revert("ERR_NOTHING_TO_WITHDRAW"):
        world.c.withdraw()
    world.vm.sender = world.provider_owner
    assert world.c.withdraw() == str(APPEAL_BOND)
    with world.vm.expect_revert("ERR_NOT_APPEALABLE"):
        world.appeal(claim_id, who=world.watchdog)
    assert [c["claim_id"] for c in world.c.list_claims(0, 10)] == [claim_id]

    stats = assert_solvent(world.c)
    assert stats["total_escrow"] == 0
    assert stats["total_bonds"] == 0


def test_legitimate_claim_settlement(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    world.appeal(claim_id)
    free_before = world.c.get_provider(world.provider_id)["free_capital"]

    # Still failing across the confirmation window: sustained breach.
    world.sample(claim_id, "DDD")
    at(world.vm, WINDOW_CLOSED)
    world.vm.sender = world.watchdog
    assert world.c.resolve_appeal(claim_id) == "CONFIRMED"

    claim = world.c.get_claim(claim_id)
    provider = world.c.get_provider(world.provider_id)
    assert claim["ruling_probe_code"] == "3/3 DOWN"
    assert claim["slash_amount"] == SLASH
    assert provider["free_capital"] == free_before - SLASH
    assert provider["total_slashed"] == SLASH
    assert provider["incidents_confirmed"] == 1
    # Reporter: bond back plus half the slash. Insured: the other half plus the
    # appellant's forfeited bond. Appellant: nothing.
    assert world.c.claimable_of(hexaddr(world.reporter)) == REPORTER_BOND + REPORTER_SHARE
    assert world.c.claimable_of(hexaddr(world.holder)) == SLASH - REPORTER_SHARE + APPEAL_BOND
    assert world.c.claimable_of(hexaddr(world.provider_owner)) == 0

    # The escrowed payout is released to the insured subscriber.
    world.vm.sender = world.watchdog
    assert world.c.claim_payout(claim_id) == str(COVERAGE)
    assert world.c.get_claim(claim_id)["status"] == "PAID"
    assert world.c.get_policy(world.policy_id)["status"] == "CLAIMED"
    assert world.c.get_provider(world.provider_id)["total_paid_out"] == COVERAGE
    with world.vm.expect_revert("ERR_ALREADY_SETTLED"):
        world.c.claim_payout(claim_id)

    world.vm.sender = world.reporter
    assert world.c.withdraw() == str(REPORTER_BOND + REPORTER_SHARE)
    world.vm.sender = world.holder
    assert world.c.withdraw() == str(SLASH - REPORTER_SHARE + APPEAL_BOND)

    stats = assert_solvent(world.c)
    assert stats["total_escrow"] == 0
    assert stats["total_bonds"] == 0
    assert stats["total_claimable"] == 0
    assert stats["total_payouts"] == COVERAGE


def test_drill_isolation(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    snapshot = (
        world.c.get_protocol_stats(),
        world.c.get_provider(world.provider_id),
        world.c.get_policy(world.policy_id),
        world.c.get_claim(claim_id),
        world.c.claimable_of(hexaddr(world.reporter)),
    )

    # Healthy target, failing target, unbound evidence: none of them move a
    # pool, escrow, bond, counter or claim.
    endpoint_healthy(world.vm)
    world.vm.sender = world.watchdog
    healthy = world.c.run_sla_drill(world.policy_id, world.provider_id, ENDPOINT, PROBE)
    assert healthy["bound"] and healthy["observed_up"]
    assert healthy["verdict"] == "REJECTED_POLICY_NOT_ACTIVE"  # the policy already has an open claim

    endpoint_down(world.vm)
    down = world.c.run_sla_drill(world.policy_id, world.provider_id, ENDPOINT, PROBE)
    assert down["observed_up"] is False and down["code"] == "HTTP_503"

    unbound = world.c.run_sla_drill(world.policy_id, world.provider_id, "https://rpc.ankr.com/eth", PROBE)
    assert unbound["bound"] is False
    assert unbound["verdict"] == "REJECTED_UNBOUND_EVIDENCE"

    after = (
        world.c.get_protocol_stats(),
        world.c.get_provider(world.provider_id),
        world.c.get_policy(world.policy_id),
        world.c.get_claim(claim_id),
        world.c.claimable_of(hexaddr(world.reporter)),
    )
    assert after == snapshot


def test_drill_predicts_filing_outcome(world):
    world.vm.sender = world.watchdog
    endpoint_healthy(world.vm)
    drill = world.c.run_sla_drill(world.policy_id, world.provider_id, ENDPOINT, PROBE)
    assert drill["verdict"] == "REJECTED_TARGET_HEALTHY"
    with world.vm.expect_revert("ERR_NO_OUTAGE_OBSERVED"):
        world.file()

    endpoint_down(world.vm, status=502)
    drill = world.c.run_sla_drill(world.policy_id, world.provider_id, ENDPOINT, PROBE)
    assert drill["verdict"] == "CLAIM_WOULD_BE_ACCEPTED"
    assert drill["required_reporter_bond"] == REPORTER_BOND
    assert drill["payout"] == COVERAGE
    claim_id = world.file()
    assert world.c.get_claim(claim_id)["filing_probe_code"] == "HTTP_502"


# --- escrow lifecycle -----------------------------------------------------------


def test_unchallenged_claim_pays_after_window(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    stats = assert_solvent(world.c)
    assert stats["total_escrow"] == COVERAGE
    assert world.c.get_policy(world.policy_id)["status"] == "CLAIM_OPEN"

    world.sample(claim_id, "DDD")
    world.vm.sender = world.holder
    with world.vm.expect_revert("ERR_CHALLENGE_WINDOW_OPEN"):
        world.c.claim_payout(claim_id)
    at(world.vm, CHALLENGE_WINDOW - 1)
    with world.vm.expect_revert("ERR_CHALLENGE_WINDOW_OPEN"):
        world.c.claim_payout(claim_id)

    at(world.vm, CHALLENGE_WINDOW)
    with world.vm.expect_revert("ERR_CHALLENGE_WINDOW_CLOSED"):
        world.appeal(claim_id)
    world.vm.sender = world.holder
    assert world.c.claim_payout(claim_id) == str(COVERAGE)
    assert world.c.claimable_of(hexaddr(world.reporter)) == REPORTER_BOND
    provider = world.c.get_provider(world.provider_id)
    assert provider["open_claims"] == 0 and provider["incidents_confirmed"] == 1
    assert provider["total_slashed"] == 0

    stats = assert_solvent(world.c)
    assert stats["total_escrow"] == 0
    assert stats["total_withdrawn"] == COVERAGE


def test_resolution_waits_for_downtime_window(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    world.vm.sender = world.watchdog
    with world.vm.expect_revert("ERR_NOT_UNDER_APPEAL"):
        world.c.resolve_appeal(claim_id)
    world.appeal(claim_id)
    for t in (MAX_DOWNTIME - 1, MAX_DOWNTIME, WINDOW_CLOSED - 1):
        at(world.vm, t)
        world.vm.sender = world.watchdog
        with world.vm.expect_revert("ERR_ADJUDICATION_NOT_READY"):
            world.c.resolve_appeal(claim_id)
    assert world.c.get_claim(claim_id)["status"] == "UNDER_APPEAL"


def test_appeal_state_guards(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    with world.vm.expect_revert("ERR_CONFLICTED_APPELLANT"):
        world.appeal(claim_id, who=world.reporter)
    with world.vm.expect_revert("ERR_CONFLICTED_APPELLANT"):
        world.appeal(claim_id, who=world.holder)
    with world.vm.expect_revert("ERR_BOND_TOO_LOW"):
        world.appeal(claim_id, bond=APPEAL_BOND - 1)
    world.appeal(claim_id, who=world.watchdog)
    with world.vm.expect_revert("ERR_ALREADY_UNDER_APPEAL"):
        world.appeal(claim_id)
    with world.vm.expect_revert("ERR_UNKNOWN_CLAIM"):
        world.appeal("0x" + "0" * 15 + "9")


def test_dismissal_after_expiry_frees_capital(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    world.appeal(claim_id)
    endpoint_healthy(world.vm)
    at(world.vm, 31 * 86_400)
    world.vm.sender = world.watchdog
    free_before = world.c.get_provider(world.provider_id)["free_capital"]
    assert world.c.resolve_appeal(claim_id) == "DISMISSED"
    provider = world.c.get_provider(world.provider_id)
    assert provider["committed_capital"] == 0
    assert provider["free_capital"] == free_before + REPORTER_BOND + COVERAGE
    assert world.c.get_policy(world.policy_id)["status"] == "RELEASED"
    assert_solvent(world.c)


# --- filing guards ------------------------------------------------------------------


def test_filing_guards(world):
    endpoint_down(world.vm)
    with world.vm.expect_revert("ERR_UNKNOWN_POLICY"):
        world.file(policy_id="0x" + "0" * 15 + "9")
    with world.vm.expect_revert("ERR_BAD_TRACE"):
        world.file(failure_trace="   ")
    with world.vm.expect_revert("ERR_BAD_TRACE"):
        world.file(failure_trace="x" * 2_001)
    with world.vm.expect_revert("ERR_BOND_TOO_LOW"):
        world.file(bond=REPORTER_BOND - 1)
    world.reporter = world.provider_owner
    with world.vm.expect_revert("ERR_CONFLICTED_REPORTER"):
        world.file()


def test_one_open_claim_per_policy_and_expiry(world):
    endpoint_down(world.vm)
    world.file()
    with world.vm.expect_revert("ERR_POLICY_NOT_ACTIVE"):
        world.file(bond=2 * REPORTER_BOND)

    world.vm.sender = world.watchdog
    policy_2 = call_with_value(world.vm, PREMIUM, world.c.purchase_coverage, world.provider_id, 5 * 10**18, 30)
    at(world.vm, 30 * 86_400)
    with world.vm.expect_revert("ERR_POLICY_EXPIRED"):
        world.file(policy_id=policy_2, bond=2 * REPORTER_BOND)


def test_transport_failure_counts_as_outage(world):
    # A target that cannot be reached at all (DNS/TLS/timeout) is down.
    clear_responses(world.vm)
    world.vm.sender = world.watchdog
    drill = world.c.run_sla_drill(world.policy_id, world.provider_id, ENDPOINT, PROBE)
    assert drill["observed_up"] is False and drill["code"] == "UNREACHABLE"


def test_malformed_rpc_responses_are_failures(world):
    world.vm.sender = world.watchdog
    cases = [
        ("not json", "MALFORMED_RESPONSE"),
        ("[1,2]", "MALFORMED_RESPONSE"),
        ('{"jsonrpc":"2.0","id":1,"result":null}', "RPC_NO_RESULT"),
    ]
    for body, code in cases:
        clear_responses(world.vm)
        pin_response(world.vm, ENDPOINT, "POST", 200, body)
        drill = world.c.run_sla_drill(world.policy_id, world.provider_id, ENDPOINT, PROBE)
        assert (drill["observed_up"], drill["code"]) == (False, code)


def test_register_rejects_zero_value(direct_vm, direct_deploy, direct_alice):
    c = direct_deploy("contracts/uptimesentry.py")
    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("ERR_ZERO_VALUE"):
        c.register_provider("Node", ENDPOINT, "JSONRPC", PROBE, MAX_DOWNTIME, 9_990, 200)
    assert c.get_protocol_stats()["providers"] == 0
    assert UNDERWRITING > 0
