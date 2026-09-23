// Plain-language explanations for contract error codes and network failures.
// Raw RPC traces are never shown in the UI; they go to the console.
const MESSAGES: Record<string, string> = {
  ERR_ZERO_VALUE: "This action must carry native GEN.",
  ERR_ZERO_BOND: "Attach a GEN bond to file this.",
  ERR_BOND_TOO_LOW: "The bond is below the current requirement. Refresh and use the displayed amount.",
  ERR_UNBOUND_EVIDENCE: "The endpoint or probe payload doesn't match what the provider registered.",
  ERR_PAYOUT_LOCKED: "The payout is held in escrow until the appeal is ruled on.",
  ERR_NO_OUTAGE_OBSERVED: "Validators found the registered endpoint healthy, so no claim was opened.",
  ERR_CHALLENGE_WINDOW_OPEN: "The challenge window is still open. The payout unlocks when it closes.",
  ERR_CHALLENGE_WINDOW_CLOSED: "The challenge window has closed; this claim can no longer be appealed.",
  ERR_ADJUDICATION_NOT_READY: "The allowed downtime window hasn't elapsed yet.",
  ERR_ALREADY_UNDER_APPEAL: "This claim is already under appeal.",
  ERR_NOT_APPEALABLE: "Only pending claims can be appealed.",
  ERR_NOT_UNDER_APPEAL: "Only claims under appeal can be ruled on.",
  ERR_CONFLICTED_APPELLANT: "The reporter and the insured holder can't appeal their own claim.",
  ERR_CONFLICTED_REPORTER: "Providers can't report incidents against their own endpoint.",
  ERR_CONFLICTED_HOLDER: "Providers can't insure their own endpoint.",
  ERR_PREMIUM_MISMATCH: "The premium changed. Refresh the quote and try again.",
  ERR_INSUFFICIENT_UNDERWRITING: "The provider doesn't have enough free capital for this coverage.",
  ERR_NOT_ACCEPTING: "This provider has paused new coverage.",
  ERR_POLICY_NOT_ACTIVE: "The policy isn't active (it may already have an open claim).",
  ERR_POLICY_EXPIRED: "The policy has expired.",
  ERR_OPEN_CLAIMS: "Capital is locked while claims against this endpoint are unresolved.",
  ERR_NOTHING_TO_WITHDRAW: "There's nothing to withdraw for this address.",
  ERR_KEYED_ENDPOINT: "Endpoints must be public and keyless. Remove API keys from the URL.",
  ERR_BAD_ENDPOINT: "Use a public https:// URL without credentials, fragments or private hosts.",
  ERR_BAD_PROBE: "The probe must be a single parameterless JSON-RPC read, or empty for HTTP GET.",
  ERR_PROVIDER_EXISTS: "That endpoint is already underwritten.",
  ERR_UNDERWRITING_TOO_LOW: "The underwriting pool is below the 10 GEN minimum.",
  ERR_PROBE_RATE_LIMITED: "This endpoint was probed in the last 5 minutes. Try again shortly.",
  ERR_NOT_PROVIDER_OWNER: "Only the endpoint's underwriter can do this.",
  ERR_CLAIM_DISMISSED: "This claim was dismissed.",
  ERR_ALREADY_SETTLED: "This claim has already been paid.",
};

export function explainError(err: unknown): string {
  const text = err instanceof Error ? `${err.message} ${String((err as { details?: unknown }).details ?? "")}` : String(err);
  const code = text.match(/ERR_[A-Z_]+/)?.[0];
  if (code) return MESSAGES[code] ?? code.replace(/^ERR_/, "").replace(/_/g, " ").toLowerCase();
  if (text.includes("CONTRACT_REJECTED")) return "The contract rejected the transaction. No funds were moved.";
  if (/FeeValueMustBeNonZero/.test(text)) return "The network rejected the fee deposit. Try again.";
  if (/server busy|execution slots/i.test(text)) return "The GenLayer RPC is at capacity. Try again in a moment.";
  if (/user rejected|user denied|rejected the request/i.test(text)) return "Cancelled in your wallet.";
  if (/insufficient funds/i.test(text)) return "Your wallet doesn't hold enough GEN for this amount plus the fee deposit.";
  if (/failed to fetch|network/i.test(text)) return "Couldn't reach the GenLayer RPC. Check your connection and try again.";
  console.error("[UptimeSentry]", err);
  return "The request failed. Details are in the browser console.";
}
