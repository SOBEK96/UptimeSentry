"""Proofs of concept for the second-round audit findings.

  1. Sitting on an unlocked withdrawal and cashing out as an outage hits
     -> execution probes the endpoint and the request expires 48h after unlock
  2. LLM triage overruling a validator-verified DOWN
     -> triage is advisory evidence; it never blocks or rejects a filing
  3. Reporter bond forfeited when sampling never reached the threshold
     -> INDETERMINATE_INSUFFICIENT_SAMPLES refunds the reporter in full
"""

from sentry_helpers import (
    APPEAL_BOND,
    CHALLENGE_WINDOW,
    COVERAGE,
    ENDPOINT,
    REPORTER_BOND,
    TRIAGE_B,
    WINDOW_CLOSED,
    assert_solvent,
    at,
    clear_responses,
    endpoint_down,
    endpoint_healthy,
    hexaddr,
    llm_answer,
    pin_response,
)

ATTO = 10**18
DAY = 86_400
UNHEALTHY = "ERR_ENDPOINT_UNHEALTHY: cannot execute withdrawal while endpoint is failing health checks"


# --- 1. withdrawal execution is gated on a healthy endpoint --------------------


def test_poc2_1_unlocked_withdrawal_cannot_cash_out_during_an_outage(world):
    world.vm.sender = world.provider_owner
    free = world.c.get_provider(world.provider_id)["free_capital"]
    world.c.request_underwriting_withdrawal(world.provider_id, free)

    # The provider waits past the timelock, holding an unlocked request, and
    # tries to execute the moment its endpoint fails, before anyone files.
    at(world.vm, DAY + 3_600)
    endpoint_down(world.vm)
    world.vm.sender = world.provider_owner
    with world.vm.expect_revert(UNHEALTHY):
        world.c.execute_underwriting_withdrawal(world.provider_id)
    assert world.c.get_provider(world.provider_id)["free_capital"] == free

    # A rate-limited probe is not a healthy one either.
    clear_responses(world.vm)
    pin_response(world.vm, ENDPOINT, "POST", 429, "slow down")
    with world.vm.expect_revert("ERR_RATE_LIMITED"):
        world.c.execute_underwriting_withdrawal(world.provider_id)

    # Once validators agree the endpoint is healthy, the withdrawal goes through.
    endpoint_healthy(world.vm)
    assert world.c.execute_underwriting_withdrawal(world.provider_id) == str(free)
    assert world.c.get_provider(world.provider_id)["free_capital"] == 0
    assert_solvent(world.c)


def test_poc2_1_unlocked_requests_expire_after_48h(world):
    world.vm.sender = world.provider_owner
    unlock = world.c.request_underwriting_withdrawal(world.provider_id, ATTO)
    provider = world.c.get_provider(world.provider_id)
    assert provider["withdrawal_unlock_at"] == unlock
    assert provider["withdrawal_expires_at"] == unlock + 2 * DAY

    # Still inside the execution window: a new request is refused.
    at(world.vm, DAY + 2 * DAY)
    with world.vm.expect_revert("ERR_WITHDRAWAL_PENDING"):
        world.c.request_underwriting_withdrawal(world.provider_id, ATTO)

    # Past unlock + 48h the request has lapsed and cannot execute...
    at(world.vm, DAY + 2 * DAY + 1)
    endpoint_healthy(world.vm)
    with world.vm.expect_revert("ERR_WITHDRAWAL_EXPIRED"):
        world.c.execute_underwriting_withdrawal(world.provider_id)

    # ...and must be re-requested, restarting the full timelock.
    new_unlock = world.c.request_underwriting_withdrawal(world.provider_id, ATTO)
    assert new_unlock == unlock + 3 * DAY + 1  # requested at unlock + 48h + 1s, plus a fresh 24h
    with world.vm.expect_revert("ERR_WITHDRAWAL_LOCKED"):
        world.c.execute_underwriting_withdrawal(world.provider_id)


# --- 2. advisory triage never overrules validators ------------------------------


def test_poc2_2_client_artifact_verdict_does_not_block_a_verified_outage(world):
    # Validators see DOWN; the model reads the trace as a client-side problem.
    endpoint_down(world.vm, triage=TRIAGE_B)
    claim_id = world.file(failure_trace="My API key expired so my requests were rejected.")
    claim = world.c.get_claim(claim_id)
    assert claim["status"] == "CLAIM_PENDING"
    assert claim["triage_verdict"] == "ADVISORY_CLIENT_ARTIFACT"
    assert claim["triage_notes"] == "The trace describes the reporter's own expired API key."

    # The verdict is evidence only: a sustained outage still pays in full.
    world.sample(claim_id, "DDD")
    at(world.vm, CHALLENGE_WINDOW)
    world.vm.sender = world.holder
    assert world.c.claim_payout(claim_id) == str(COVERAGE)
    assert_solvent(world.c)


def test_poc2_2_unusable_model_output_is_recorded_as_an_abstention(world):
    for answer in ("no json here", llm_answer("maybe", "unsure")):
        endpoint_down(world.vm, triage=answer)
        claim_id = world.file(bond=world.c.required_reporter_bond(world.provider_id))
        claim = world.c.get_claim(claim_id)
        assert claim["status"] == "CLAIM_PENDING"
        assert claim["triage_verdict"] == "ADVISORY_INCONCLUSIVE"
        assert claim["triage_notes"].startswith("Triage unavailable")
        # Free the policy for the next filing.
        world.policy_id = _fresh_policy(world)


def test_poc2_2_triage_notes_are_sanitised_and_bounded(world):
    long_notes = "<script>" + "x" * 1_000
    endpoint_down(world.vm, triage=llm_answer("A", long_notes))
    claim_id = world.file()
    notes = world.c.get_claim(claim_id)["triage_notes"]
    assert "<" not in notes and ">" not in notes
    assert len(notes) <= 280


# --- 3. insufficient samples refund the reporter --------------------------------


def test_poc2_3_unappealed_claim_without_enough_samples_refunds_the_reporter(world, direct_vm):
    for samples in ("", "D", "DD"):
        snap = direct_vm.snapshot()
        endpoint_down(world.vm)
        claim_id = world.file()
        if samples:
            world.sample(claim_id, samples)
        at(world.vm, CHALLENGE_WINDOW)
        world.vm.sender = world.holder
        free_before = world.c.get_provider(world.provider_id)["free_capital"]
        assert world.c.claim_payout(claim_id) == "INDETERMINATE_INSUFFICIENT_SAMPLES"

        claim = world.c.get_claim(claim_id)
        provider = world.c.get_provider(world.provider_id)
        assert claim["status"] == "INDETERMINATE_INSUFFICIENT_SAMPLES"
        assert world.c.claimable_of(hexaddr(world.reporter)) == REPORTER_BOND  # refunded, not forfeited
        assert provider["free_capital"] == free_before  # provider gains nothing
        assert provider["committed_capital"] == COVERAGE  # escrow back behind the live policy
        assert provider["open_claims"] == 0
        assert world.c.get_policy(world.policy_id)["status"] == "ACTIVE"
        stats = assert_solvent(world.c)
        assert stats["total_escrow"] == 0 and stats["total_payouts"] == 0
        with world.vm.expect_revert("ERR_CLAIM_DISMISSED"):
            world.c.claim_payout(claim_id)
        world.vm.sender = world.reporter
        assert world.c.withdraw() == str(REPORTER_BOND)
        direct_vm.revert(snap)


def test_poc2_3_appealed_claim_without_enough_samples_refunds_both_sides(world):
    endpoint_down(world.vm)
    claim_id = world.file()
    world.appeal(claim_id)
    world.sample(claim_id, "DD")
    at(world.vm, WINDOW_CLOSED)
    world.vm.sender = world.watchdog
    assert world.c.resolve_appeal(claim_id) == "INDETERMINATE_INSUFFICIENT_SAMPLES"
    assert world.c.claimable_of(hexaddr(world.reporter)) == REPORTER_BOND
    assert world.c.claimable_of(hexaddr(world.provider_owner)) == APPEAL_BOND
    assert world.c.get_provider(world.provider_id)["total_slashed"] == 0
    stats = assert_solvent(world.c)
    assert stats["total_bonds"] == 0 and stats["total_escrow"] == 0


def test_poc2_3_a_demonstrated_recovery_still_forfeits_the_bond(world):
    # Contrast: three samples with a healthy majority is a demonstrated
    # recovery, so the reporter's bond still compensates the provider.
    endpoint_down(world.vm)
    claim_id = world.file()
    world.sample(claim_id, "UUD")
    at(world.vm, CHALLENGE_WINDOW)
    world.vm.sender = world.holder
    free_before = world.c.get_provider(world.provider_id)["free_capital"]
    assert world.c.claim_payout(claim_id) == "RECOVERED"
    assert world.c.claimable_of(hexaddr(world.reporter)) == 0
    assert world.c.get_provider(world.provider_id)["free_capital"] == free_before + REPORTER_BOND


def _fresh_policy(world):
    from sentry_helpers import call_with_value

    world.vm.sender = world.watchdog
    premium = world.c.quote_premium(world.provider_id, COVERAGE, 30)
    return call_with_value(world.vm, premium, world.c.purchase_coverage, world.provider_id, COVERAGE, 30)


def test_poc2_2_a_failing_model_call_never_blocks_filing(world, direct_vm):
    # No model answer at all: the call itself errors. The filing still stands.
    direct_vm.clear_mocks()
    pin_response(direct_vm, ENDPOINT, "POST", 503, "down")
    claim_id = world.file()
    claim = world.c.get_claim(claim_id)
    assert claim["status"] == "CLAIM_PENDING"
    assert (claim["triage_verdict"], claim["triage_notes"]) == ("ADVISORY_INCONCLUSIVE", "Triage unavailable (model error).")
