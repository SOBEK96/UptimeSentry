# { "Depends": "py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng" }

# UptimeSentry -- parametric SLA insurance and downtime adjudication on GenLayer.
#
# Infrastructure providers register a public, keyless RPC / health endpoint
# together with the exact probe payload that defines "healthy", and lock an
# underwriting pool of native GEN behind it. Subscribers buy fully
# collateralised coverage against that endpoint. Anyone may report an outage by
# posting a bond; the report is only accepted if GenLayer validators,
# independently probing the REGISTERED endpoint with the REGISTERED payload,
# agree the target is failing right now. The payout is then escrowed for a
# challenge window. A provider or watchdog may appeal with an escalating bond;
# the appeal is ruled by a second consensus probe taken no earlier than the
# provider's allowed downtime window after filing. A breach is therefore two
# independent consensus observations of failure spanning the SLA window.
#
# Value is real native GEN end to end: every deposit, premium and bond is
# gl.message.value, and every exit is a gl.chain.Account(...).emit_transfer.
# The contract keeps an explicit ledger (total_deposited - total_withdrawn ==
# underwriting + escrow + bonds + claimable) that is exposed for audit.

import hashlib
import json
import typing
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit

import genlayer as gl
from genlayer import Address, u64, u256
from genlayer.storage import DynArray, TreeMap

allow_storage = gl.storage.allow

# --- Economic parameters (atto-GEN, 1 GEN = 10**18) --------------------------

ATTO = 10**18
BPS = 10_000

MIN_UNDERWRITING = 10 * ATTO
MIN_COVERAGE = 1 * ATTO
REPORTER_BOND_BASE = 1 * ATTO
APPEAL_BOND_BASE = 2 * ATTO
APPEAL_BOND_BPS = 1_000  # appeal bond is at least 10% of the escrowed payout
ESCALATION_CAP = 8  # bonds escalate 2^n, capped at 256x the base

SLASH_BPS = 2_000  # confirmed breach slashes 20% of the payout from free capital
REPORTER_SLASH_SHARE_BPS = 5_000  # half of the slash rewards the reporter

MAX_PREMIUM_BPS = 5_000  # per 30 days of cover
MIN_TERM_DAYS = 1
MAX_TERM_DAYS = 90

# --- Time parameters (seconds) ---------------------------------------------

DAY = 86_400
CHALLENGE_WINDOW = DAY
DISPUTE_EPOCH = 7 * DAY
MIN_DOWNTIME_WINDOW = 300
MAX_DOWNTIME_WINDOW = CHALLENGE_WINDOW
PROBE_ATTEST_INTERVAL = 300

# --- Telemetry ---------------------------------------------------------------

PROBE_JSONRPC = "JSONRPC"
PROBE_HTTP_GET = "HTTP_GET"

# Read-only, parameterless JSON-RPC methods. A probe must be side-effect free
# and produce the same healthy/unhealthy answer on every validator.
JSONRPC_PROBE_METHODS = (
    "eth_blockNumber",
    "eth_chainId",
    "eth_syncing",
    "eth_gasPrice",
    "net_version",
    "net_listening",
    "web3_clientVersion",
    "getHealth",
    "getSlot",
    "getBlockHeight",
    "getVersion",
)

CREDENTIAL_QUERY_HINTS = ("key", "token", "secret", "auth", "sig", "password", "pass", "session")
BLOCKED_HOST_SUFFIXES = (".local", ".internal", ".localhost", ".lan", ".home", ".corp")
MAX_URL_LEN = 256
MAX_TRACE_LEN = 2_000
MAX_NAME_LEN = 64
MAX_PAGE = 50

# --- Lifecycle states ---------------------------------------------------------

POLICY_ACTIVE = "ACTIVE"
POLICY_CLAIM_OPEN = "CLAIM_OPEN"
POLICY_CLAIMED = "CLAIMED"
POLICY_RELEASED = "RELEASED"

CLAIM_PENDING = "CLAIM_PENDING"
CLAIM_UNDER_APPEAL = "UNDER_APPEAL"
CLAIM_CONFIRMED = "CONFIRMED"
CLAIM_DISMISSED = "DISMISSED"
CLAIM_PAID = "PAID"

# --- Error codes -----------------------------------------------------------------

ERR_UNBOUND_EVIDENCE = "ERR_UNBOUND_EVIDENCE: incident telemetry does not match registered target"
ERR_PAYOUT_LOCKED = "ERR_PAYOUT_LOCKED: funds preserved until appeal resolution"


def _fail(code: str, detail: str = "") -> typing.NoReturn:
    raise gl.vm.UserError(f"{code}: {detail}" if detail else code)


# --- Storage -------------------------------------------------------------------


@allow_storage
@dataclass
class Provider:
    provider_id: str
    owner: str
    name: str
    endpoint_url: str
    probe_kind: str
    probe_payload: str
    max_downtime_s: u64
    target_availability_bps: u64
    premium_bps: u64
    accepting: bool
    free_capital: u256
    committed_capital: u256
    open_claims: u64
    dispute_seq: u64
    dispute_epoch_start: u64
    probes_total: u64
    probes_up: u64
    last_probe_at: u64
    last_probe_code: str
    incidents_confirmed: u64
    incidents_dismissed: u64
    total_slashed: u256
    total_paid_out: u256
    registered_at: u64


@allow_storage
@dataclass
class Policy:
    policy_id: str
    provider_id: str
    holder: str
    coverage: u256
    premium: u256
    starts_at: u64
    expires_at: u64
    status: str


@allow_storage
@dataclass
class Claim:
    claim_id: str
    policy_id: str
    provider_id: str
    reporter: str
    holder: str
    payout: u256
    reporter_bond: u256
    appellant: str
    appeal_bond: u256
    status: str
    filed_at: u64
    challenge_deadline: u64
    confirm_after: u64
    resolved_at: u64
    filing_probe_code: str
    ruling_probe_code: str
    failure_trace: str
    evidence_hash: str
    slash_amount: u256


# --- Pure helpers -----------------------------------------------------------------


def _hex(addr: Address) -> str:
    return addr.as_hex.lower()


def _canonical_json(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _escalated(base: int, n: int) -> int:
    return base * (2 ** min(n, ESCALATION_CAP))


def _is_blocked_host(host: str) -> bool:
    if host in ("localhost", "0.0.0.0", "::1", "[::1]"):
        return True
    for suffix in BLOCKED_HOST_SUFFIXES:
        if host.endswith(suffix):
            return True
    parts = host.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        a, b = int(parts[0]), int(parts[1])
        if a in (0, 10, 127) or (a == 169 and b == 254) or (a == 192 and b == 168):
            return True
        if a == 172 and 16 <= b <= 31:
            return True
        if a == 100 and 64 <= b <= 127:
            return True
    return False


def _looks_like_credential(segment: str) -> bool:
    # Hosted RPC gateways embed API keys as long opaque path segments
    # (e.g. /v3/9aa3d95b3bc440fa88ea12eaa4456161). A keyless public endpoint
    # has no such segment.
    if len(segment) < 20:
        return False
    if not all(c.isalnum() or c in "-_" for c in segment):
        return False
    has_digit = any(c.isdigit() for c in segment)
    has_alpha = any(c.isalpha() for c in segment)
    return has_digit and has_alpha


def _validate_endpoint(url: str) -> None:
    if not isinstance(url, str) or len(url) < 12 or len(url) > MAX_URL_LEN:
        _fail("ERR_BAD_ENDPOINT", "endpoint length out of bounds")
    if url != url.strip() or any(ord(c) <= 32 or ord(c) == 127 for c in url):
        _fail("ERR_BAD_ENDPOINT", "whitespace or control characters")
    if not url.startswith("https://"):
        _fail("ERR_BAD_ENDPOINT", "endpoint must use https")
    parts = urlsplit(url)
    if "@" in parts.netloc or parts.fragment:
        _fail("ERR_BAD_ENDPOINT", "userinfo and fragments are not allowed")
    host = (parts.hostname or "").lower()
    if host == "" or "." not in host or _is_blocked_host(host):
        _fail("ERR_BAD_ENDPOINT", "endpoint host must be a public domain")
    if parts.query:
        for pair in parts.query.split("&"):
            name = pair.split("=", 1)[0].lower()
            for hint in CREDENTIAL_QUERY_HINTS:
                if hint in name:
                    _fail("ERR_KEYED_ENDPOINT", "endpoint must be public and keyless")
    for segment in parts.path.split("/"):
        if _looks_like_credential(segment):
            _fail("ERR_KEYED_ENDPOINT", "endpoint must be public and keyless")


def _canonical_probe_payload(probe_kind: str, payload: str) -> str:
    """Normalise a probe definition to its canonical on-chain form, or fail.

    JSONRPC: a single parameterless JSON-RPC 2.0 request for a read-only method,
    re-serialised with sorted keys so byte-level formatting never matters.
    HTTP_GET: the payload is empty -- the endpoint URL alone is the health check.
    """
    if probe_kind == PROBE_HTTP_GET:
        if payload.strip() != "":
            _fail("ERR_BAD_PROBE", "HTTP_GET probes carry no payload")
        return ""
    if probe_kind != PROBE_JSONRPC:
        _fail("ERR_BAD_PROBE", "probe kind must be JSONRPC or HTTP_GET")
    try:
        obj = json.loads(payload)
    except Exception:
        _fail("ERR_BAD_PROBE", "payload is not JSON")
    if not isinstance(obj, dict):
        _fail("ERR_BAD_PROBE", "payload must be a single JSON-RPC request object")
    if set(obj.keys()) - {"jsonrpc", "id", "method", "params"}:
        _fail("ERR_BAD_PROBE", "unexpected JSON-RPC fields")
    if obj.get("jsonrpc") != "2.0":
        _fail("ERR_BAD_PROBE", "jsonrpc must be 2.0")
    method = obj.get("method")
    if method not in JSONRPC_PROBE_METHODS:
        _fail("ERR_BAD_PROBE", "method is not an allowed read-only probe")
    params = obj.get("params", [])
    if params != []:
        _fail("ERR_BAD_PROBE", "probe params must be empty")
    req_id = obj.get("id", 1)
    if isinstance(req_id, bool) or not isinstance(req_id, int) or req_id < 0 or req_id > 2**31:
        _fail("ERR_BAD_PROBE", "id must be a small non-negative integer")
    return _canonical_json({"id": req_id, "jsonrpc": "2.0", "method": method, "params": []})


def _classify_response(probe_kind: str, status: int, body: bytes | None) -> dict:
    """Deterministically reduce an HTTP response to {up, code}."""
    if status < 200 or status >= 300:
        return {"up": False, "code": f"HTTP_{status}"}
    if probe_kind == PROBE_HTTP_GET:
        return {"up": True, "code": "UP"}
    try:
        data = json.loads((body or b"").decode("utf-8"))
    except Exception:
        return {"up": False, "code": "MALFORMED_RESPONSE"}
    if not isinstance(data, dict):
        return {"up": False, "code": "MALFORMED_RESPONSE"}
    if data.get("error") is not None:
        return {"up": False, "code": "RPC_ERROR"}
    if data.get("result") is None:
        return {"up": False, "code": "RPC_NO_RESULT"}
    return {"up": True, "code": "UP"}


def _probe_once(url: str, probe_kind: str, payload: str) -> dict:
    """One live observation of the registered target. Transport failures
    (DNS, TLS, connect/read timeouts) are an outage, not an error."""
    try:
        if probe_kind == PROBE_JSONRPC:
            res = gl.nondet.web.post(
                url,
                body=payload,
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
        else:
            res = gl.nondet.web.get(url)
    except Exception:
        return {"up": False, "code": "UNREACHABLE"}
    return _classify_response(probe_kind, res.status, res.body)


def _consensus_probe(url: str, probe_kind: str, payload: str) -> dict:
    """Validators each probe the target independently and must agree on the
    health verdict. The failure code is informational (a 503 on one node and a
    timeout on another are the same outage), so only `up` is compared."""

    def leader_fn() -> dict:
        return _probe_once(url, probe_kind, payload)

    def validator_fn(leaders_res: gl.vm.Result) -> bool:
        if not isinstance(leaders_res, gl.vm.Return):
            return False
        claimed = leaders_res.calldata
        if not isinstance(claimed, dict) or not isinstance(claimed.get("up"), bool):
            return False
        code = claimed.get("code")
        if not isinstance(code, str) or (code == "UP") != claimed["up"]:
            return False
        return _probe_once(url, probe_kind, payload)["up"] == claimed["up"]

    return gl.vm.run_nondet(leader_fn, validator_fn)


# --- Contract ---------------------------------------------------------------------


class UptimeSentry(gl.contract.Contract):
    providers: TreeMap[str, Provider]
    provider_ids: DynArray[str]
    policies: TreeMap[str, Policy]
    policy_ids: DynArray[str]
    claims: TreeMap[str, Claim]
    claim_ids: DynArray[str]
    claimable: TreeMap[str, u256]

    total_underwriting: u256
    total_escrow: u256
    total_bonds: u256
    total_claimable: u256
    total_deposited: u256
    total_withdrawn: u256
    total_premiums: u256
    total_payouts: u256

    def __init__(self):
        self.total_underwriting = u256(0)
        self.total_escrow = u256(0)
        self.total_bonds = u256(0)
        self.total_claimable = u256(0)
        self.total_deposited = u256(0)
        self.total_withdrawn = u256(0)
        self.total_premiums = u256(0)
        self.total_payouts = u256(0)

    # --- internal helpers ---------------------------------------------------------

    def _now(self) -> int:
        return int(datetime.now(timezone.utc).timestamp())

    def _provider(self, provider_id: str) -> Provider:
        if provider_id not in self.providers:
            _fail("ERR_UNKNOWN_PROVIDER")
        return self.providers[provider_id]

    def _policy(self, policy_id: str) -> Policy:
        if policy_id not in self.policies:
            _fail("ERR_UNKNOWN_POLICY")
        return self.policies[policy_id]

    def _claim(self, claim_id: str) -> Claim:
        if claim_id not in self.claims:
            _fail("ERR_UNKNOWN_CLAIM")
        return self.claims[claim_id]

    def _receive(self) -> int:
        value = int(gl.message.value)
        self.total_deposited += value
        return value

    def _credit(self, who: str, amount: int) -> None:
        current = self.claimable[who] if who in self.claimable else u256(0)
        self.claimable[who] = current + amount
        self.total_claimable += amount

    def _send(self, to_hex: str, amount: int) -> None:
        self.total_withdrawn += amount
        gl.chain.Account(Address(to_hex)).emit_transfer(u256(amount), on="finalized")

    def _required_reporter_bond(self, p: Provider) -> int:
        # Each concurrently open claim against the same provider doubles the
        # bond, so locking a provider's capital with a burst of reports is
        # exponentially expensive.
        return _escalated(REPORTER_BOND_BASE, int(p.open_claims))

    def _effective_dispute_seq(self, p: Provider, now: int) -> int:
        if now >= int(p.dispute_epoch_start) + DISPUTE_EPOCH:
            return 0
        return int(p.dispute_seq)

    def _required_appeal_bond(self, c: Claim, p: Provider, now: int) -> int:
        # The Nth dispute against a provider inside one epoch costs 2^(N-1)
        # times the base, so blanket-appealing every claim to delay payouts, or
        # racing sybil appeals, drains the appellant rather than the pool.
        base = max(APPEAL_BOND_BASE, int(c.payout) * APPEAL_BOND_BPS // BPS)
        return _escalated(base, self._effective_dispute_seq(p, now))

    def _release_policy_backing(self, pol: Policy, p: Provider, amount: int, now: int) -> None:
        # Escrow that is not paid out returns to the pool. If the policy is
        # still in force it keeps backing it; otherwise it becomes free capital.
        if now < int(pol.expires_at):
            p.committed_capital += amount
            pol.status = POLICY_ACTIVE
        else:
            p.free_capital += amount
            pol.status = POLICY_RELEASED
        self.total_underwriting += amount
        self.total_escrow -= amount

    # --- provider registry ----------------------------------------------------------

    @gl.public.write.payable
    def register_provider(
        self,
        name: str,
        endpoint_url: str,
        probe_kind: str,
        probe_payload: str,
        max_downtime_s: int,
        target_availability_bps: int,
        premium_bps: int,
    ) -> str:
        if int(gl.message.value) == 0:
            _fail("ERR_ZERO_VALUE", "underwriting pool must be funded with native GEN")
        if int(gl.message.value) < MIN_UNDERWRITING:
            _fail("ERR_UNDERWRITING_TOO_LOW", f"minimum is {MIN_UNDERWRITING}")
        name = name.strip()
        if len(name) == 0 or len(name) > MAX_NAME_LEN:
            _fail("ERR_BAD_NAME")
        _validate_endpoint(endpoint_url)
        canonical = _canonical_probe_payload(probe_kind, probe_payload)
        if max_downtime_s < MIN_DOWNTIME_WINDOW or max_downtime_s > MAX_DOWNTIME_WINDOW:
            _fail("ERR_BAD_SLA", "max downtime window out of bounds")
        if target_availability_bps < 9_000 or target_availability_bps > BPS:
            _fail("ERR_BAD_SLA", "target availability must be 90.00%-100.00%")
        if premium_bps < 1 or premium_bps > MAX_PREMIUM_BPS:
            _fail("ERR_BAD_PREMIUM_RATE")

        provider_id = "0x" + hashlib.sha256(endpoint_url.encode("utf-8")).hexdigest()[:40]
        if provider_id in self.providers:
            _fail("ERR_PROVIDER_EXISTS", "endpoint already registered")

        value = self._receive()
        now = self._now()
        self.providers[provider_id] = Provider(
            provider_id=provider_id,
            owner=_hex(gl.message.sender_address),
            name=name,
            endpoint_url=endpoint_url,
            probe_kind=probe_kind,
            probe_payload=canonical,
            max_downtime_s=u64(max_downtime_s),
            target_availability_bps=u64(target_availability_bps),
            premium_bps=u64(premium_bps),
            accepting=True,
            free_capital=u256(value),
            committed_capital=u256(0),
            open_claims=u64(0),
            dispute_seq=u64(0),
            dispute_epoch_start=u64(0),
            probes_total=u64(0),
            probes_up=u64(0),
            last_probe_at=u64(0),
            last_probe_code="",
            incidents_confirmed=u64(0),
            incidents_dismissed=u64(0),
            total_slashed=u256(0),
            total_paid_out=u256(0),
            registered_at=u64(now),
        )
        self.provider_ids.append(provider_id)
        self.total_underwriting += value
        return provider_id

    @gl.public.write.payable
    def deposit_underwriting(self, provider_id: str) -> None:
        p = self._provider(provider_id)
        if _hex(gl.message.sender_address) != p.owner:
            _fail("ERR_NOT_PROVIDER_OWNER")
        if int(gl.message.value) == 0:
            _fail("ERR_ZERO_VALUE", "deposit must carry native GEN")
        value = self._receive()
        p.free_capital += value
        self.total_underwriting += value

    @gl.public.write
    def withdraw_underwriting(self, provider_id: str, amount: int) -> None:
        p = self._provider(provider_id)
        owner = _hex(gl.message.sender_address)
        if owner != p.owner:
            _fail("ERR_NOT_PROVIDER_OWNER")
        if amount <= 0:
            _fail("ERR_ZERO_VALUE")
        # Free capital is the slashing base: it cannot leave while any claim
        # against this provider is unresolved.
        if int(p.open_claims) > 0:
            _fail("ERR_OPEN_CLAIMS", "capital is locked while claims are unresolved")
        if amount > int(p.free_capital):
            _fail("ERR_INSUFFICIENT_FREE_CAPITAL")
        p.free_capital -= amount
        self.total_underwriting -= amount
        self._send(owner, amount)

    @gl.public.write
    def set_accepting_policies(self, provider_id: str, accepting: bool) -> None:
        p = self._provider(provider_id)
        if _hex(gl.message.sender_address) != p.owner:
            _fail("ERR_NOT_PROVIDER_OWNER")
        p.accepting = accepting

    # --- coverage ---------------------------------------------------------------------

    def _quote(self, p: Provider, coverage: int, term_days: int) -> int:
        if coverage < MIN_COVERAGE:
            _fail("ERR_COVERAGE_TOO_LOW", f"minimum is {MIN_COVERAGE}")
        if term_days < MIN_TERM_DAYS or term_days > MAX_TERM_DAYS:
            _fail("ERR_BAD_TERM", "term must be 1-90 days")
        # MIN_COVERAGE and premium_bps >= 1 keep this strictly positive.
        return coverage * int(p.premium_bps) * term_days // (BPS * 30)

    @gl.public.write.payable
    def purchase_coverage(self, provider_id: str, coverage: int, term_days: int) -> str:
        if int(gl.message.value) == 0:
            _fail("ERR_ZERO_VALUE", "premium must be paid in native GEN")
        p = self._provider(provider_id)
        holder = _hex(gl.message.sender_address)
        if holder == p.owner:
            _fail("ERR_CONFLICTED_HOLDER", "providers cannot insure their own endpoint")
        if not p.accepting:
            _fail("ERR_NOT_ACCEPTING", "provider has paused new coverage")
        premium = self._quote(p, coverage, term_days)
        if int(gl.message.value) != premium:
            _fail("ERR_PREMIUM_MISMATCH", f"premium is {premium}")
        if coverage > int(p.free_capital):
            _fail("ERR_INSUFFICIENT_UNDERWRITING", "coverage exceeds free underwriting capital")

        self._receive()
        now = self._now()
        policy_id = f"0x{len(self.policy_ids) + 1:016x}"
        # Fully collateralised: the whole coverage moves from free to committed
        # capital for the life of the policy. The premium is earned by the pool.
        p.free_capital -= coverage
        p.committed_capital += coverage
        p.free_capital += premium
        self.total_underwriting += premium
        self.total_premiums += premium
        self.policies[policy_id] = Policy(
            policy_id=policy_id,
            provider_id=provider_id,
            holder=holder,
            coverage=u256(coverage),
            premium=u256(premium),
            starts_at=u64(now),
            expires_at=u64(now + term_days * DAY),
            status=POLICY_ACTIVE,
        )
        self.policy_ids.append(policy_id)
        return policy_id

    @gl.public.write
    def release_expired_policy(self, policy_id: str) -> None:
        pol = self._policy(policy_id)
        if pol.status != POLICY_ACTIVE:
            _fail("ERR_POLICY_NOT_ACTIVE")
        if self._now() < int(pol.expires_at):
            _fail("ERR_POLICY_IN_FORCE")
        p = self.providers[pol.provider_id]
        p.committed_capital -= pol.coverage
        p.free_capital += pol.coverage
        pol.status = POLICY_RELEASED

    # --- incidents ----------------------------------------------------------------------

    def _check_binding(
        self, pol: Policy, target_provider_id: str, target_endpoint_url: str, probe_payload: str
    ) -> Provider:
        if target_provider_id != pol.provider_id:
            raise gl.vm.UserError(ERR_UNBOUND_EVIDENCE)
        p = self.providers[pol.provider_id]
        if target_endpoint_url != p.endpoint_url:
            raise gl.vm.UserError(ERR_UNBOUND_EVIDENCE)
        try:
            canonical = _canonical_probe_payload(p.probe_kind, probe_payload)
        except gl.vm.UserError:
            raise gl.vm.UserError(ERR_UNBOUND_EVIDENCE)
        if canonical != p.probe_payload:
            raise gl.vm.UserError(ERR_UNBOUND_EVIDENCE)
        return p

    @gl.public.write.payable
    def file_incident(
        self,
        policy_id: str,
        target_provider_id: str,
        target_endpoint_url: str,
        probe_payload: str,
        failure_trace: str,
    ) -> str:
        if int(gl.message.value) == 0:
            _fail("ERR_ZERO_BOND", "incident reports require a native GEN reporter bond")
        pol = self._policy(policy_id)
        p = self._check_binding(pol, target_provider_id, target_endpoint_url, probe_payload)
        now = self._now()
        if pol.status != POLICY_ACTIVE:
            _fail("ERR_POLICY_NOT_ACTIVE")
        if now >= int(pol.expires_at):
            _fail("ERR_POLICY_EXPIRED")
        reporter = _hex(gl.message.sender_address)
        if reporter == p.owner:
            _fail("ERR_CONFLICTED_REPORTER", "providers cannot report against themselves")
        if len(failure_trace.strip()) == 0 or len(failure_trace) > MAX_TRACE_LEN:
            _fail("ERR_BAD_TRACE", "failure trace must be 1-2000 characters")
        required = self._required_reporter_bond(p)
        if int(gl.message.value) < required:
            _fail("ERR_BOND_TOO_LOW", f"reporter bond is {required}")

        observed = _consensus_probe(p.endpoint_url, p.probe_kind, p.probe_payload)
        if observed["up"]:
            _fail("ERR_NO_OUTAGE_OBSERVED", "consensus probe of the registered target is healthy")

        bond = self._receive()
        self.total_bonds += bond
        claim_id = f"0x{len(self.claim_ids) + 1:016x}"
        evidence_hash = hashlib.sha256(
            _canonical_json(
                {
                    "claim_id": claim_id,
                    "provider_id": p.provider_id,
                    "endpoint_url": p.endpoint_url,
                    "probe_payload": p.probe_payload,
                    "failure_trace": failure_trace,
                    "filed_at": now,
                    "observed": observed["code"],
                }
            ).encode("utf-8")
        ).hexdigest()

        payout = int(pol.coverage)
        p.committed_capital -= payout
        p.open_claims += 1
        self.total_underwriting -= payout
        self.total_escrow += payout
        pol.status = POLICY_CLAIM_OPEN

        self.claims[claim_id] = Claim(
            claim_id=claim_id,
            policy_id=policy_id,
            provider_id=p.provider_id,
            reporter=reporter,
            holder=pol.holder,
            payout=u256(payout),
            reporter_bond=u256(bond),
            appellant="",
            appeal_bond=u256(0),
            status=CLAIM_PENDING,
            filed_at=u64(now),
            challenge_deadline=u64(now + CHALLENGE_WINDOW),
            confirm_after=u64(now + int(p.max_downtime_s)),
            resolved_at=u64(0),
            filing_probe_code=observed["code"],
            ruling_probe_code="",
            failure_trace=failure_trace,
            evidence_hash=evidence_hash,
            slash_amount=u256(0),
        )
        self.claim_ids.append(claim_id)
        return claim_id

    @gl.public.write.payable
    def file_appeal(self, claim_id: str) -> None:
        if int(gl.message.value) == 0:
            _fail("ERR_ZERO_BOND", "appeals require a native GEN appeal bond")
        c = self._claim(claim_id)
        if c.status == CLAIM_UNDER_APPEAL:
            _fail("ERR_ALREADY_UNDER_APPEAL")
        if c.status != CLAIM_PENDING:
            _fail("ERR_NOT_APPEALABLE")
        now = self._now()
        if now >= int(c.challenge_deadline):
            _fail("ERR_CHALLENGE_WINDOW_CLOSED")
        appellant = _hex(gl.message.sender_address)
        if appellant == c.reporter or appellant == c.holder:
            _fail("ERR_CONFLICTED_APPELLANT")
        p = self.providers[c.provider_id]
        required = self._required_appeal_bond(c, p, now)
        if int(gl.message.value) < required:
            _fail("ERR_BOND_TOO_LOW", f"appeal bond is {required}")

        bond = self._receive()
        self.total_bonds += bond
        if self._effective_dispute_seq(p, now) == 0:
            p.dispute_epoch_start = u64(now)
            p.dispute_seq = u64(0)
        p.dispute_seq += 1
        c.appellant = appellant
        c.appeal_bond = u256(bond)
        c.status = CLAIM_UNDER_APPEAL

    @gl.public.write
    def resolve_appeal(self, claim_id: str) -> str:
        c = self._claim(claim_id)
        if c.status != CLAIM_UNDER_APPEAL:
            _fail("ERR_NOT_UNDER_APPEAL")
        now = self._now()
        if now < int(c.confirm_after):
            _fail("ERR_ADJUDICATION_NOT_READY", "outage must persist past the SLA downtime window")
        p = self.providers[c.provider_id]
        pol = self.policies[c.policy_id]

        observed = _consensus_probe(p.endpoint_url, p.probe_kind, p.probe_payload)
        c.ruling_probe_code = observed["code"]
        c.resolved_at = u64(now)
        p.open_claims -= 1
        reporter_bond = int(c.reporter_bond)
        appeal_bond = int(c.appeal_bond)
        self.total_bonds -= reporter_bond + appeal_bond

        if not observed["up"]:
            # Sustained outage confirmed: the payout stays escrowed for the
            # insured, the provider is slashed, the reporter is rewarded and the
            # appellant forfeits its bond to the insured for the delay.
            slash = min(int(p.free_capital), int(c.payout) * SLASH_BPS // BPS)
            reporter_share = slash * REPORTER_SLASH_SHARE_BPS // BPS
            p.free_capital -= slash
            p.total_slashed += slash
            p.incidents_confirmed += 1
            self.total_underwriting -= slash
            c.slash_amount = u256(slash)
            self._credit(c.reporter, reporter_bond + reporter_share)
            self._credit(c.holder, slash - reporter_share + appeal_bond)
            c.status = CLAIM_CONFIRMED
        else:
            # Target recovered inside the allowed window: not an SLA breach.
            # The reporter's bond is forfeited to the provider's pool, the
            # escrow returns to underwriting and the appellant is refunded.
            p.free_capital += reporter_bond
            self.total_underwriting += reporter_bond
            p.incidents_dismissed += 1
            self._release_policy_backing(pol, p, int(c.payout), now)
            self._credit(c.appellant, appeal_bond)
            c.status = CLAIM_DISMISSED
        return c.status

    @gl.public.write
    def claim_payout(self, claim_id: str) -> str:
        c = self._claim(claim_id)
        if c.status == CLAIM_UNDER_APPEAL:
            raise gl.vm.UserError(ERR_PAYOUT_LOCKED)
        if c.status == CLAIM_DISMISSED:
            _fail("ERR_CLAIM_DISMISSED")
        if c.status == CLAIM_PAID:
            _fail("ERR_ALREADY_SETTLED")
        now = self._now()
        p = self.providers[c.provider_id]
        if c.status == CLAIM_PENDING:
            if now < int(c.challenge_deadline):
                _fail("ERR_CHALLENGE_WINDOW_OPEN", "payout unlocks when the challenge window closes")
            # Unchallenged: the filing's consensus observation stands.
            p.open_claims -= 1
            p.incidents_confirmed += 1
            bond = int(c.reporter_bond)
            self.total_bonds -= bond
            self._credit(c.reporter, bond)
            c.resolved_at = u64(now)
        payout = int(c.payout)
        c.status = CLAIM_PAID
        self.policies[c.policy_id].status = POLICY_CLAIMED
        p.total_paid_out += payout
        self.total_escrow -= payout
        self.total_payouts += payout
        self._send(c.holder, payout)
        return str(payout)

    @gl.public.write
    def withdraw(self) -> str:
        who = _hex(gl.message.sender_address)
        amount = int(self.claimable[who]) if who in self.claimable else 0
        if amount == 0:
            _fail("ERR_NOTHING_TO_WITHDRAW")
        self.claimable[who] = u256(0)
        self.total_claimable -= amount
        self._send(who, amount)
        return str(amount)

    # --- telemetry --------------------------------------------------------------------

    @gl.public.write
    def attest_probe(self, provider_id: str) -> dict:
        """Record one consensus health observation of a provider's registered
        target. Builds the on-chain observed-availability metric."""
        p = self._provider(provider_id)
        now = self._now()
        if int(p.last_probe_at) != 0 and now < int(p.last_probe_at) + PROBE_ATTEST_INTERVAL:
            _fail("ERR_PROBE_RATE_LIMITED", f"one attestation per {PROBE_ATTEST_INTERVAL}s")
        observed = _consensus_probe(p.endpoint_url, p.probe_kind, p.probe_payload)
        p.probes_total += 1
        if observed["up"]:
            p.probes_up += 1
        p.last_probe_at = u64(now)
        p.last_probe_code = observed["code"]
        return {"up": observed["up"], "code": observed["code"], "at": now}

    @gl.public.view
    def run_sla_drill(
        self,
        policy_id: str,
        target_provider_id: str,
        target_endpoint_url: str,
        probe_payload: str,
    ) -> dict:
        """Dry-run the full adjudication path of file_incident against live
        telemetry: evidence binding, policy state, bond pricing and a consensus
        probe of the registered target. Read-only -- touches no pool, escrow,
        bond or counter."""
        pol = self._policy(policy_id)
        try:
            p = self._check_binding(pol, target_provider_id, target_endpoint_url, probe_payload)
        except gl.vm.UserError:
            return {
                "bound": False,
                "verdict": "REJECTED_UNBOUND_EVIDENCE",
                "error": ERR_UNBOUND_EVIDENCE,
                "observed_up": False,
                "code": "",
                "required_reporter_bond": 0,
            }
        now = self._now()
        in_force = pol.status == POLICY_ACTIVE and now < int(pol.expires_at)
        observed = _consensus_probe(p.endpoint_url, p.probe_kind, p.probe_payload)
        if not in_force:
            verdict = "REJECTED_POLICY_NOT_ACTIVE"
        elif observed["up"]:
            verdict = "REJECTED_TARGET_HEALTHY"
        else:
            verdict = "CLAIM_WOULD_BE_ACCEPTED"
        return {
            "bound": True,
            "verdict": verdict,
            "error": "",
            "observed_up": observed["up"],
            "code": observed["code"],
            "required_reporter_bond": self._required_reporter_bond(p),
            "payout": int(pol.coverage),
            "challenge_window_s": CHALLENGE_WINDOW,
            "confirm_after_s": int(p.max_downtime_s),
            "observed_at": now,
        }

    # --- views ------------------------------------------------------------------------

    def _provider_view(self, p: Provider) -> dict:
        total = int(p.probes_total)
        return {
            "provider_id": p.provider_id,
            "owner": p.owner,
            "name": p.name,
            "endpoint_url": p.endpoint_url,
            "probe_kind": p.probe_kind,
            "probe_payload": p.probe_payload,
            "max_downtime_s": int(p.max_downtime_s),
            "target_availability_bps": int(p.target_availability_bps),
            "observed_availability_bps": (int(p.probes_up) * BPS // total) if total > 0 else -1,
            "premium_bps": int(p.premium_bps),
            "accepting": p.accepting,
            "free_capital": int(p.free_capital),
            "committed_capital": int(p.committed_capital),
            "open_claims": int(p.open_claims),
            "probes_total": total,
            "probes_up": int(p.probes_up),
            "last_probe_at": int(p.last_probe_at),
            "last_probe_code": p.last_probe_code,
            "incidents_confirmed": int(p.incidents_confirmed),
            "incidents_dismissed": int(p.incidents_dismissed),
            "total_slashed": int(p.total_slashed),
            "total_paid_out": int(p.total_paid_out),
            "registered_at": int(p.registered_at),
            "required_reporter_bond": self._required_reporter_bond(p),
        }

    def _policy_view(self, pol: Policy) -> dict:
        return {
            "policy_id": pol.policy_id,
            "provider_id": pol.provider_id,
            "holder": pol.holder,
            "coverage": int(pol.coverage),
            "premium": int(pol.premium),
            "starts_at": int(pol.starts_at),
            "expires_at": int(pol.expires_at),
            "status": pol.status,
        }

    def _claim_view(self, c: Claim) -> dict:
        p = self.providers[c.provider_id]
        appeal_bond_now = 0
        if c.status == CLAIM_PENDING:
            appeal_bond_now = self._required_appeal_bond(c, p, self._now())
        return {
            "claim_id": c.claim_id,
            "policy_id": c.policy_id,
            "provider_id": c.provider_id,
            "reporter": c.reporter,
            "holder": c.holder,
            "payout": int(c.payout),
            "reporter_bond": int(c.reporter_bond),
            "appellant": c.appellant,
            "appeal_bond": int(c.appeal_bond),
            "required_appeal_bond": appeal_bond_now,
            "status": c.status,
            "filed_at": int(c.filed_at),
            "challenge_deadline": int(c.challenge_deadline),
            "confirm_after": int(c.confirm_after),
            "resolved_at": int(c.resolved_at),
            "filing_probe_code": c.filing_probe_code,
            "ruling_probe_code": c.ruling_probe_code,
            "failure_trace": c.failure_trace,
            "evidence_hash": c.evidence_hash,
            "slash_amount": int(c.slash_amount),
        }

    @gl.public.view
    def get_provider(self, provider_id: str) -> dict:
        return self._provider_view(self._provider(provider_id))

    @gl.public.view
    def get_policy(self, policy_id: str) -> dict:
        return self._policy_view(self._policy(policy_id))

    @gl.public.view
    def get_claim(self, claim_id: str) -> dict:
        return self._claim_view(self._claim(claim_id))

    @gl.public.view
    def list_providers(self, offset: int, limit: int) -> list:
        ids = self.provider_ids
        end = min(len(ids), offset + min(limit, MAX_PAGE))
        return [self._provider_view(self.providers[ids[i]]) for i in range(max(offset, 0), end)]

    @gl.public.view
    def list_policies(self, offset: int, limit: int) -> list:
        ids = self.policy_ids
        end = min(len(ids), offset + min(limit, MAX_PAGE))
        return [self._policy_view(self.policies[ids[i]]) for i in range(max(offset, 0), end)]

    @gl.public.view
    def list_claims(self, offset: int, limit: int) -> list:
        ids = self.claim_ids
        end = min(len(ids), offset + min(limit, MAX_PAGE))
        return [self._claim_view(self.claims[ids[i]]) for i in range(max(offset, 0), end)]

    @gl.public.view
    def quote_premium(self, provider_id: str, coverage: int, term_days: int) -> int:
        return self._quote(self._provider(provider_id), coverage, term_days)

    @gl.public.view
    def required_reporter_bond(self, provider_id: str) -> int:
        return self._required_reporter_bond(self._provider(provider_id))

    @gl.public.view
    def required_appeal_bond(self, claim_id: str) -> int:
        c = self._claim(claim_id)
        return self._required_appeal_bond(c, self.providers[c.provider_id], self._now())

    @gl.public.view
    def claimable_of(self, address_hex: str) -> int:
        key = address_hex.lower()
        return int(self.claimable[key]) if key in self.claimable else 0

    @gl.public.view
    def get_protocol_stats(self) -> dict:
        liabilities = (
            int(self.total_underwriting)
            + int(self.total_escrow)
            + int(self.total_bonds)
            + int(self.total_claimable)
        )
        net_inflow = int(self.total_deposited) - int(self.total_withdrawn)
        return {
            "providers": len(self.provider_ids),
            "policies": len(self.policy_ids),
            "claims": len(self.claim_ids),
            "total_underwriting": int(self.total_underwriting),
            "total_escrow": int(self.total_escrow),
            "total_bonds": int(self.total_bonds),
            "total_claimable": int(self.total_claimable),
            "total_deposited": int(self.total_deposited),
            "total_withdrawn": int(self.total_withdrawn),
            "total_premiums": int(self.total_premiums),
            "total_payouts": int(self.total_payouts),
            "liabilities": liabilities,
            "net_inflow": net_inflow,
            "solvent": liabilities == net_inflow,
            "challenge_window_s": CHALLENGE_WINDOW,
            "dispute_epoch_s": DISPUTE_EPOCH,
            "reporter_bond_base": REPORTER_BOND_BASE,
            "appeal_bond_base": APPEAL_BOND_BASE,
            "slash_bps": SLASH_BPS,
            "min_underwriting": MIN_UNDERWRITING,
            "min_coverage": MIN_COVERAGE,
        }
