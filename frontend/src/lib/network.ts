import { studioDevnet, studionet, testnetAsimov, testnetBradbury } from "genlayer-js/chains";

type ChainKey = "testnetBradbury" | "testnetAsimov" | "studionet" | "studioDevnet";

const CHAINS = { testnetBradbury, testnetAsimov, studionet, studioDevnet } as const;

const LABELS: Record<ChainKey, string> = {
  testnetBradbury: "GenLayer Bradbury Testnet",
  testnetAsimov: "GenLayer Asimov Testnet",
  studionet: "GenLayer Studio",
  studioDevnet: "GenLayer Studio Next",
};

function chainKey(): ChainKey {
  const raw = import.meta.env.VITE_GENLAYER_NETWORK;
  return raw && raw in CHAINS ? (raw as ChainKey) : "testnetBradbury";
}

export const NETWORK_KEY = chainKey();
export const NETWORK_LABEL = LABELS[NETWORK_KEY];

const base = CHAINS[NETWORK_KEY];
const rpcOverride = import.meta.env.VITE_GENLAYER_RPC_URL;

// The SDK's own chain object carries the consensus contract and fee-policy
// fields writes depend on; only the RPC endpoint is overridden.
export const CHAIN = rpcOverride
  ? { ...base, rpcUrls: { ...base.rpcUrls, default: { http: [rpcOverride] } } }
  : base;

const rawAddress = (import.meta.env.VITE_UPTIMESENTRY_ADDRESS ?? "").trim();
export const CONTRACT_ADDRESS: `0x${string}` | null = /^0x[0-9a-fA-F]{40}$/.test(rawAddress)
  ? (rawAddress as `0x${string}`)
  : null;

export const EXPLORER_URL: string | null =
  import.meta.env.VITE_GENLAYER_EXPLORER_URL?.replace(/\/$/, "") || CHAIN.blockExplorers?.default.url || null;

export const CHAIN_ID = CHAIN.id;
export const REPO_URL = "https://github.com/SOBEK96/UptimeSentry";
export const STUDIO_URL = "https://studio-next.genlayer.com";
