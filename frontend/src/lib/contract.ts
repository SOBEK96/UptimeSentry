import { createAccount, createClient, generatePrivateKey } from "genlayer-js";
import { TransactionStatus, type TransactionHash } from "genlayer-js/types";
import type { Claim, DrillResult, Policy, Provider, ProtocolStats } from "./types";
import { CHAIN, CONTRACT_ADDRESS } from "./network";
import { toBig, toNum } from "./format";
import { withRetry, withTimeout, type RetryOptions } from "./rpc";
import { demo } from "./demo";

type Plain = Record<string, unknown>;

// Contract views return calldata maps; flatten them into plain objects.
function plain(v: unknown): unknown {
  if (v instanceof Map) {
    const out: Plain = {};
    v.forEach((val, key) => (out[String(key)] = plain(val)));
    return out;
  }
  if (Array.isArray(v)) return v.map(plain);
  return v;
}

const BIG_FIELDS = new Set([
  "free_capital",
  "committed_capital",
  "total_slashed",
  "total_paid_out",
  "required_reporter_bond",
  "coverage",
  "premium",
  "payout",
  "reporter_bond",
  "appeal_bond",
  "required_appeal_bond",
  "slash_amount",
  "total_underwriting",
  "total_escrow",
  "total_bonds",
  "total_claimable",
  "total_deposited",
  "total_withdrawn",
  "total_premiums",
  "total_payouts",
  "liabilities",
  "net_inflow",
  "reporter_bond_base",
  "appeal_bond_base",
  "min_underwriting",
  "min_coverage",
]);

function typed<T>(v: unknown): T {
  const o = plain(v) as Plain;
  const out: Plain = {};
  for (const [k, val] of Object.entries(o)) {
    if (BIG_FIELDS.has(k)) out[k] = toBig(val);
    else if (typeof val === "bigint") out[k] = toNum(val);
    else out[k] = val;
  }
  return out as T;
}

function requireAddress(): `0x${string}` {
  if (!CONTRACT_ADDRESS) throw new Error("No UptimeSentry contract address is configured.");
  return CONTRACT_ADDRESS;
}

const reader = createClient({ chain: CHAIN });

// Studio Next serves plain reads without executing a method's non-deterministic
// block (the node returns "leader_fault nondet_output absent"). The drill's live
// probe is one, so it is run as a write *simulation*: the node executes it as
// leader and commits nothing. Simulation needs a sender but signs nothing, so
// a throwaway key stands in.
const simulator = createClient({ chain: CHAIN, account: createAccount(generatePrivateKey()) });

type Arg = string | number | bigint | boolean;

function read(functionName: string, args: Arg[] = [], retry?: RetryOptions): Promise<unknown> {
  return withRetry(() => withTimeout(reader.readContract({ address: requireAddress(), functionName, args })), retry);
}

const list = async <T,>(fn: string, retry?: RetryOptions) =>
  ((plain(await read(fn, [0, 50], retry)) as unknown[]) ?? []).map((x) => typed<T>(x));

export const views = {
  stats: async (retry?: RetryOptions) => typed<ProtocolStats>(await read("get_protocol_stats", [], retry)),
  providers: (retry?: RetryOptions) => list<Provider>("list_providers", retry),
  policies: (retry?: RetryOptions) => list<Policy>("list_policies", retry),
  claims: (retry?: RetryOptions) => list<Claim>("list_claims", retry),
  quote: async (providerId: string, coverage: bigint, termDays: number) =>
    demo.get().active ? demo.quote(providerId, coverage, termDays) : toBig(await read("quote_premium", [providerId, coverage, termDays])),
  claimable: async (address: string) => toBig(await read("claimable_of", [address.toLowerCase()])),
  drill: async (policyId: string, providerId: string, url: string, payload: string) =>
    demo.get().active
      ? demo.drill(policyId, providerId, url, payload)
      : typed<DrillResult>(
      await withRetry(() =>
        simulator.simulateWriteContract({ address: requireAddress(), functionName: "run_sla_drill", args: [policyId, providerId, url, payload] }),
      ),
    ),
};

export const chainReads = {
  balance: (address: `0x${string}`) => withRetry(() => withTimeout(reader.getBalance({ address }))),
  /** The consensus fee deposit GenLayer requires on every transaction. */
  feeDeposit: async () => (await withRetry(() => withTimeout(reader.estimateTransactionFees()))).feeValue as bigint,
};

export type WriteArgs = Arg[];

export interface WriteHooks {
  onSubmitted?: (hash: string) => void;
}

export async function write(
  account: `0x${string}`,
  functionName: string,
  args: WriteArgs,
  value: bigint = 0n,
  hooks: WriteHooks = {},
): Promise<string> {
  const client = createClient({ chain: CHAIN, account });
  // Non-payable calls get a dry run first so a contract rejection surfaces
  // with its error code before anything is signed.
  if (value === 0n) {
    await withRetry(() => client.simulateWriteContract({ address: requireAddress(), functionName, args }));
  }
  // Two separate amounts travel with a write: `value` is the native GEN the
  // contract receives (gl.message.value, in wei); `fees.feeValue` is the
  // consensus fee deposit. Studio Next rejects a zero deposit with
  // FeeValueMustBeNonZero, so it is quoted fresh before every write.
  const { distribution, messageAllocations, feeValue } = await withRetry(() => client.estimateTransactionFees());
  const hash = String(
    await client.writeContract({
      address: requireAddress(),
      functionName,
      args,
      value,
      fees: { distribution, messageAllocations, feeValue },
    }),
  );
  hooks.onSubmitted?.(hash);
  const receipt = await withRetry(
    () =>
      client.waitForTransactionReceipt({
        hash: hash as TransactionHash,
        status: TransactionStatus.ACCEPTED,
        interval: 4000,
        retries: 150,
      }),
    { retries: 4 },
  );
  if (receipt.txExecutionResultName === "FINISHED_WITH_ERROR") {
    throw new Error("CONTRACT_REJECTED");
  }
  return hash;
}
