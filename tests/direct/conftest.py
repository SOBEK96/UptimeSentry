"""Fixtures for the UptimeSentry direct-mode suite (helpers live in sentry_helpers)."""

import pytest

from sentry_helpers import World


@pytest.fixture
def world(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, direct_accounts):
    watchdog = direct_accounts[4]
    return World(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie, watchdog)
