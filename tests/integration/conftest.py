"""Fixtures for the UptimeSentry integration suite: full leader + validator
consensus against a live GenLayer network that carries native value.

    make test-integration                      # Studio Next (studio_devnet)
    make test-integration NETWORK=localnet     # `genlayer up` (Docker)

On a fee-charging network the suite signs with the keys in
UPTIMESENTRY_TEST_KEYS (comma-separated, at least three distinct funded
accounts: provider/appellant, holder, reporter). See tests/integration/README.md.

When no network answers, these tests skip so an offline `pytest` stays usable;
`make test-integration` sets UPTIMESENTRY_REQUIRE_NETWORK=1 so an unreachable
network fails the run instead.
"""

import os

import pytest
from gltest import get_contract_factory
from eth_account import Account
from gltest.accounts import get_accounts
from gltest.clients import get_gl_client

from sentry_client import ATTO, WAIT_INTERVAL_MS, WAIT_RETRIES, SentryClient, live_fees


@pytest.fixture(scope="session", autouse=True)
def network_available():
    try:
        get_gl_client().w3.eth.chain_id  # noqa: B018 - reachability probe
    except Exception as exc:
        if os.environ.get("UPTIMESENTRY_REQUIRE_NETWORK") == "1":
            pytest.fail(f"GenLayer network unreachable: {exc}")
        pytest.skip(f"no GenLayer network reachable ({type(exc).__name__}); see tests/integration/README.md, then `make test-integration`")


# Balance each role must hold before the run: two 10 GEN pools, rejected
# registrations that must still attach 10 GEN, premiums, bonds and fee deposits.
REQUIRED_GEN = {"provider": 35, "holder": 2, "reporter": 4}


@pytest.fixture(scope="session")
def accounts(network_available):
    """provider (also appellant and prober), holder, reporter."""
    keys = [k.strip() for k in os.environ.get("UPTIMESENTRY_TEST_KEYS", "").split(",") if k.strip()]
    accts = [Account.from_key(k) for k in keys] if keys else get_accounts()[:3]
    if len({a.address for a in accts}) < 3:
        pytest.fail("UPTIMESENTRY_TEST_KEYS must hold at least three distinct private keys")
    roles = dict(zip(("provider", "holder", "reporter"), accts[:3]))

    client = get_gl_client()
    short = []
    for role, acct in roles.items():
        need = REQUIRED_GEN[role] * ATTO
        if client.w3.eth.get_balance(acct.address) < need:
            try:  # local networks fund on request
                client.provider.make_request("sim_fundAccount", [acct.address, 1_000 * ATTO])
            except Exception:
                pass
            if client.w3.eth.get_balance(acct.address) < need:
                short.append(f"{role} {acct.address} needs {REQUIRED_GEN[role]} GEN")
    if short:
        msg = "unfunded test accounts: " + "; ".join(short) + ". Fund them or set UPTIMESENTRY_TEST_KEYS."
        if os.environ.get("UPTIMESENTRY_REQUIRE_NETWORK") == "1":
            pytest.fail(msg)
        pytest.skip(msg)
    roles["watchdog"] = roles["provider"]
    return roles


@pytest.fixture(scope="module")
def sentry(accounts):
    factory = get_contract_factory(contract_file_path="uptimesentry.py")
    contract = factory.deploy(
        args=[],
        account=accounts["provider"],
        fees=live_fees(),
        wait_until="finalized",
        wait_interval=WAIT_INTERVAL_MS,
        wait_retries=WAIT_RETRIES,
    )
    return SentryClient(contract.address)
