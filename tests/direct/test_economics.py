"""Economic security: native-value backing, escalating bonds, capital locks,
endpoint hygiene and the consensus validator."""

import json

from sentry_helpers import (
    APPEAL_BOND,
    COVERAGE,
    ENDPOINT,
    MAX_DOWNTIME,
    PREMIUM,
    PROBE,
    PROBE_CANONICAL,
    REPORTER_BOND,
    UNDERWRITING,
    WINDOW_CLOSED,
    assert_solvent,
    at,
    call_with_value,
    clear_responses,
    endpoint_down,
    endpoint_healthy,
    hexaddr,
    pin_response,
)

ATTO = 10**18


def _buy(world, who, coverage=COVERAGE, days=30):
    world.vm.sender = who
    premium = world.c.quote_premium(world.provider_id, coverage, days)
    return call_with_value(world.vm, premium, world.c.purchase_coverage, world.provider_id, coverage, days)


# --- registration ---------------------------------------------------------------------


def test_registration_state(world):
    p = world.c.get_provider(world.provider_id)
    assert p["owner"] == hexaddr(world.provider_owner)
    assert p["endpoint_url"] == ENDPOINT
    assert p["probe_payload"] == PROBE_CANONICAL
    assert p["free_capital"] == UNDERWRITING - COVERAGE + PREMIUM
    assert p["committed_capital"] == COVERAGE
    assert p["observed_availability_bps"] == -1
    assert world.c.list_providers(0, 10)[0]["provider_id"] == world.provider_id
    assert world.c.list_policies(0, 10)[0]["policy_id"] == world.policy_id
    assert_solvent(world.c)


def test_registration_guards(world):
    vm, c = world.vm, world.c
    vm.sender = world.watchdog

    def reg(value=UNDERWRITING, url="https://rpc.ankr.com/eth", kind="JSONRPC", payload=PROBE, window=600, bps=9_990, prem=200, name="Ankr"):
        return call_with_value(vm, value, c.register_provider, name, url, kind, payload, window, bps, prem)

    with vm.expect_revert("ERR_UNDERWRITING_TOO_LOW"):
        reg(value=ATTO)
    with vm.expect_revert("ERR_PROVIDER_EXISTS"):
        reg(url=ENDPOINT)
    with vm.expect_revert("ERR_BAD_NAME"):
        reg(name=" ")
    with vm.expect_revert("ERR_BAD_SLA"):
        reg(window=299)
    with vm.expect_revert("ERR_BAD_SLA"):
        reg(window=86_401)
    with vm.expect_revert("ERR_BAD_SLA"):
        reg(bps=8_999)
    with vm.expect_revert("ERR_BAD_PREMIUM_RATE"):
        reg(prem=0)
    with vm.expect_revert("ERR_BAD_PROBE"):
        reg(kind="PING")
    with vm.expect_revert("ERR_BAD_PROBE"):
        reg(payload='{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":[]}')
    with vm.expect_revert("ERR_BAD_PROBE"):
        reg(payload='{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":["latest"]}')
    with vm.expect_revert("ERR_BAD_PROBE"):
        reg(payload='[{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}]')
    with vm.expect_revert("ERR_BAD_PROBE"):
        reg(kind="HTTP_GET", payload=PROBE)
    with vm.expect_revert("ERR_BAD_PROBE"):
        reg(payload='{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[],"extra":1}')
    with vm.expect_revert("ERR_BAD_PROBE"):
        reg(payload='{"jsonrpc":"1.0","id":1,"method":"eth_blockNumber","params":[]}')
    with vm.expect_revert("ERR_BAD_PROBE"):
        reg(payload='{"jsonrpc":"2.0","id":true,"method":"eth_blockNumber","params":[]}')
    assert c.get_protocol_stats()["providers"] == 1

    # A plain HTTP health endpoint is a valid target too.
    pid = reg(url="https://status.example-infra.org/health", kind="HTTP_GET", payload="")
    assert c.get_provider(pid)["probe_kind"] == "HTTP_GET"
    assert_solvent(c)


def test_endpoint_must_be_public_and_keyless(world):
    vm, c = world.vm, world.c
    vm.sender = world.watchdog
    bad = {
        "http://rpc.ankr.com/eth": "ERR_BAD_ENDPOINT",
        "https://localhost:8545/rpc": "ERR_BAD_ENDPOINT",
        "https://10.0.0.5/rpc": "ERR_BAD_ENDPOINT",
        "https://169.254.169.254/latest": "ERR_BAD_ENDPOINT",
        "https://node.internal/rpc": "ERR_BAD_ENDPOINT",
        "https://0.0.0.0/rpc": "ERR_BAD_ENDPOINT",
        "https://172.20.1.1/rpc": "ERR_BAD_ENDPOINT",
        "https://100.64.0.1/rpc": "ERR_BAD_ENDPOINT",
        "https://a.b": "ERR_BAD_ENDPOINT",
        "https://user:pw@rpc.example.org": "ERR_BAD_ENDPOINT",
        "https://rpc.example.org/#frag": "ERR_BAD_ENDPOINT",
        "https://rpc.example.org/ x": "ERR_BAD_ENDPOINT",
        "https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161": "ERR_KEYED_ENDPOINT",
        "https://rpc.example.org/eth?apikey=abc": "ERR_KEYED_ENDPOINT",
        "https://rpc.example.org/eth?access_token=abc": "ERR_KEYED_ENDPOINT",
    }
    for url, code in bad.items():
        with vm.expect_revert(code):
            call_with_value(vm, UNDERWRITING, c.register_provider, "X", url, "JSONRPC", PROBE, 600, 9_990, 200)
    assert c.get_protocol_stats()["providers"] == 1

    # Long but non-opaque path segments are ordinary public routes.
    pid = call_with_value(
        vm, UNDERWRITING, c.register_provider, "Public", "https://rpc.example.org/mainnet.public-archive.v2",
        "JSONRPC", PROBE, 600, 9_990, 200,
    )
    assert c.get_provider(pid)["endpoint_url"].endswith("mainnet.public-archive.v2")


# --- coverage ----------------------------------------------------------------------------


def test_purchase_guards(world):
    vm, c = world.vm, world.c
    vm.sender = world.watchdog
    with vm.expect_revert("ERR_ZERO_VALUE"):
        c.purchase_coverage(world.provider_id, COVERAGE, 30)
    with vm.expect_revert("ERR_PREMIUM_MISMATCH"):
        call_with_value(vm, PREMIUM - 1, c.purchase_coverage, world.provider_id, COVERAGE, 30)
    with vm.expect_revert("ERR_COVERAGE_TOO_LOW"):
        call_with_value(vm, 1, c.purchase_coverage, world.provider_id, ATTO - 1, 30)
    with vm.expect_revert("ERR_BAD_TERM"):
        call_with_value(vm, PREMIUM, c.purchase_coverage, world.provider_id, COVERAGE, 91)
    with vm.expect_revert("ERR_UNKNOWN_PROVIDER"):
        call_with_value(vm, PREMIUM, c.purchase_coverage, "0x" + "00" * 20, COVERAGE, 30)
    big = 100 * ATTO
    with vm.expect_revert("ERR_INSUFFICIENT_UNDERWRITING"):
        call_with_value(vm, c.quote_premium(world.provider_id, big, 30), c.purchase_coverage, world.provider_id, big, 30)

    vm.sender = world.provider_owner
    with vm.expect_revert("ERR_CONFLICTED_HOLDER"):
        call_with_value(vm, PREMIUM, c.purchase_coverage, world.provider_id, COVERAGE, 30)
    c.set_accepting_policies(world.provider_id, False)
    vm.sender = world.watchdog
    with vm.expect_revert("ERR_NOT_ACCEPTING"):
        call_with_value(vm, PREMIUM, c.purchase_coverage, world.provider_id, COVERAGE, 30)
    with vm.expect_revert("ERR_NOT_PROVIDER_OWNER"):
        c.set_accepting_policies(world.provider_id, True)
    assert c.get_protocol_stats()["policies"] == 1


def test_release_expired_policy(world):
    vm, c = world.vm, world.c
    vm.sender = world.watchdog
    with vm.expect_revert("ERR_POLICY_IN_FORCE"):
        c.release_expired_policy(world.policy_id)
    at(vm, 30 * 86_400)
    free_before = c.get_provider(world.provider_id)["free_capital"]
    c.release_expired_policy(world.policy_id)
    p = c.get_provider(world.provider_id)
    assert p["committed_capital"] == 0
    assert p["free_capital"] == free_before + COVERAGE
    assert c.get_policy(world.policy_id)["status"] == "RELEASED"
    with vm.expect_revert("ERR_POLICY_NOT_ACTIVE"):
        c.release_expired_policy(world.policy_id)
    assert_solvent(c)


# --- underwriting capital ---------------------------------------------------------------


def test_underwriting_deposit_and_withdraw(world):
    vm, c = world.vm, world.c
    vm.sender = world.provider_owner
    with vm.expect_revert("ERR_ZERO_VALUE"):
        c.deposit_underwriting(world.provider_id)
    call_with_value(vm, 3 * ATTO, c.deposit_underwriting, world.provider_id)
    free = c.get_provider(world.provider_id)["free_capital"]
    with vm.expect_revert("ERR_ZERO_VALUE"):
        c.request_underwriting_withdrawal(world.provider_id, 0)
    with vm.expect_revert("ERR_INSUFFICIENT_FREE_CAPITAL"):
        c.request_underwriting_withdrawal(world.provider_id, free + 1)
    c.request_underwriting_withdrawal(world.provider_id, ATTO)
    at(vm, 86_400)
    endpoint_healthy(vm)  # execution probes the endpoint
    c.execute_underwriting_withdrawal(world.provider_id)
    assert c.get_provider(world.provider_id)["free_capital"] == free - ATTO

    vm.sender = world.watchdog
    with vm.expect_revert("ERR_NOT_PROVIDER_OWNER"):
        c.request_underwriting_withdrawal(world.provider_id, ATTO)
    with vm.expect_revert("ERR_NOT_PROVIDER_OWNER"):
        call_with_value(vm, ATTO, c.deposit_underwriting, world.provider_id)
    stats = assert_solvent(c)
    assert stats["total_withdrawn"] == ATTO


def test_capital_locked_while_claims_open(world):
    world.vm.sender = world.provider_owner
    world.c.request_underwriting_withdrawal(world.provider_id, ATTO)
    endpoint_down(world.vm)
    claim_id = world.file()
    world.appeal(claim_id)
    # Past the timelock, but the provider still cannot pull free capital out
    # from under a pending slash.
    at(world.vm, 86_400)
    world.vm.sender = world.provider_owner
    with world.vm.expect_revert("ERR_OPEN_CLAIMS"):
        world.c.execute_underwriting_withdrawal(world.provider_id)

    world.vm.sender = world.watchdog
    # No samples: nothing demonstrated, stakes returned, claim closed.
    assert world.c.resolve_appeal(claim_id) == "INDETERMINATE_INSUFFICIENT_SAMPLES"
    world.vm.sender = world.provider_owner
    endpoint_healthy(world.vm)
    assert world.c.execute_underwriting_withdrawal(world.provider_id) == str(ATTO)
    assert_solvent(world.c)


# --- anti-griefing escalation ---------------------------------------------------------


def test_reporter_bonds_escalate_with_open_claims(world):
    policies = [world.policy_id] + [_buy(world, world.watchdog) for _ in range(3)]
    endpoint_down(world.vm)
    required = []
    for i, pid in enumerate(policies):
        bond = world.c.required_reporter_bond(world.provider_id)
        required.append(bond)
        if i > 0:
            with world.vm.expect_revert("ERR_BOND_TOO_LOW"):
                world.file(policy_id=pid, bond=bond - 1)
        world.file(policy_id=pid, bond=bond)
    assert required == [REPORTER_BOND, 2 * REPORTER_BOND, 4 * REPORTER_BOND, 8 * REPORTER_BOND]
    assert world.c.get_provider(world.provider_id)["open_claims"] == 4
    assert_solvent(world.c)


def test_appeal_bonds_escalate_per_epoch(world):
    policies = [world.policy_id] + [_buy(world, world.holder) for _ in range(2)]
    endpoint_down(world.vm)
    claims = []
    for pid in policies:
        claims.append(world.file(policy_id=pid, bond=world.c.required_reporter_bond(world.provider_id)))

    paid = []
    for claim_id in claims:
        bond = world.c.required_appeal_bond(claim_id)
        assert world.c.get_claim(claim_id)["required_appeal_bond"] == bond
        with world.vm.expect_revert("ERR_BOND_TOO_LOW"):
            world.appeal(claim_id, bond=bond - 1)
        world.appeal(claim_id, bond=bond)
        paid.append(bond)
    assert paid == [APPEAL_BOND, 2 * APPEAL_BOND, 4 * APPEAL_BOND]

    # The escalation decays once the dispute epoch has passed.
    _buy(world, world.holder, days=30)
    at(world.vm, 7 * 86_400)
    pid = world.c.list_policies(0, 10)[-1]["policy_id"]
    claim_id = world.file(policy_id=pid, bond=world.c.required_reporter_bond(world.provider_id))
    assert world.c.required_appeal_bond(claim_id) == APPEAL_BOND
    assert_solvent(world.c)


def test_appeal_bond_scales_with_payout(world):
    endpoint_down(world.vm)
    world.vm.sender = world.watchdog
    big = 40 * ATTO
    pid = call_with_value(
        world.vm, world.c.quote_premium(world.provider_id, big, 30), world.c.purchase_coverage, world.provider_id, big, 30
    )
    claim_id = world.file(policy_id=pid)
    assert world.c.required_appeal_bond(claim_id) == big // 10


def test_slash_is_capped_by_free_capital(world):
    vm, c = world.vm, world.c
    # Commit almost the entire pool so the slash exceeds remaining free capital.
    free = c.get_provider(world.provider_id)["free_capital"]
    cover = free - (free // 50)
    vm.sender = world.watchdog
    pid = call_with_value(vm, c.quote_premium(world.provider_id, cover, 1), c.purchase_coverage, world.provider_id, cover, 1)
    endpoint_down(vm)
    claim_id = world.file(policy_id=pid)
    world.appeal(claim_id, bond=c.required_appeal_bond(claim_id))
    remaining = c.get_provider(world.provider_id)["free_capital"]
    world.sample(claim_id, "DDD")
    at(vm, WINDOW_CLOSED)
    c.resolve_appeal(claim_id)
    claim = c.get_claim(claim_id)
    assert claim["status"] == "CONFIRMED"
    assert claim["slash_amount"] == remaining
    assert c.get_provider(world.provider_id)["free_capital"] == 0
    assert_solvent(c)


def test_withdraw_requires_balance(world):
    world.vm.sender = world.watchdog
    with world.vm.expect_revert("ERR_NOTHING_TO_WITHDRAW"):
        world.c.withdraw()


# --- telemetry attestations ----------------------------------------------------------


def test_attest_probe_builds_availability(world):
    vm, c = world.vm, world.c
    vm.sender = world.watchdog
    endpoint_healthy(vm)
    assert c.attest_probe(world.provider_id)["up"] is True
    with vm.expect_revert("ERR_PROBE_RATE_LIMITED"):
        c.attest_probe(world.provider_id)
    for i, healthy in enumerate([True, True, False]):
        at(vm, 300 * (i + 1))
        (endpoint_healthy if healthy else endpoint_down)(vm)
        c.attest_probe(world.provider_id)
    p = c.get_provider(world.provider_id)
    assert (p["probes_total"], p["probes_up"]) == (4, 3)
    assert p["observed_availability_bps"] == 7_500
    assert p["last_probe_code"] == "HTTP_503"
    with vm.expect_revert("ERR_UNKNOWN_PROVIDER"):
        c.attest_probe("0x" + "00" * 20)


def test_http_get_provider_lifecycle(world):
    vm, c = world.vm, world.c
    url = "https://status.example-infra.org/health"
    vm.sender = world.watchdog
    pid = call_with_value(vm, UNDERWRITING, c.register_provider, "Status", url, "HTTP_GET", "", 600, 9_990, 200)
    vm.sender = world.holder
    pol = call_with_value(vm, c.quote_premium(pid, COVERAGE, 30), c.purchase_coverage, pid, COVERAGE, 30)

    clear_responses(vm)
    pin_response(vm, url, "GET", 200, "ok")
    vm.sender = world.reporter
    with vm.expect_revert("ERR_NO_OUTAGE_OBSERVED"):
        call_with_value(vm, REPORTER_BOND, c.file_incident, pol, pid, url, "", "GET /health -> timeout")
    with vm.expect_revert("ERR_UNBOUND_EVIDENCE"):
        call_with_value(vm, REPORTER_BOND, c.file_incident, pol, pid, url, PROBE, "GET /health -> timeout")

    clear_responses(vm)
    pin_response(vm, url, "GET", 500, "down")
    claim_id = call_with_value(vm, REPORTER_BOND, c.file_incident, pol, pid, url, "", "GET /health -> 500")
    assert c.get_claim(claim_id)["filing_probe_code"] == "HTTP_500"
    assert_solvent(c)


# --- consensus validator ---------------------------------------------------------------


def test_validators_disagree_when_they_observe_a_different_state(world):
    endpoint_down(world.vm)
    world.file()
    # The validator re-probes the endpoint independently: seeing the same
    # outage it agrees; seeing a healthy target it rejects the leader.
    # (index 0 is the probe; index 1 is the LLM triage that follows it.)
    assert world.vm.run_validator(index=0) is True
    endpoint_healthy(world.vm)
    assert world.vm.run_validator(index=0) is False


def test_validators_reject_malformed_leader_results(world):
    endpoint_down(world.vm)
    world.file()
    assert world.vm.run_validator(index=0, leader_result={"state": "DOWN", "code": "HTTP_503"}) is True
    # A leader claiming "down" while labelling the code UP is inconsistent.
    assert world.vm.run_validator(index=0, leader_result={"state": "DOWN", "code": "UP"}) is False
    assert world.vm.run_validator(index=0, leader_result={"state": "DOWN", "code": "HTTP_429"}) is False
    assert world.vm.run_validator(index=0, leader_result={"state": "no", "code": "HTTP_503"}) is False
    assert world.vm.run_validator(index=0, leader_result=json.dumps({"state": "DOWN"})) is False
    assert world.vm.run_validator(index=0, leader_error=Exception("leader crashed")) is False
