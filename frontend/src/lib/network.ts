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
  return raw && raw in CHAINS ? (raw as ChainKey) : "studioDevnet";
}

// Verified Studio Next deployment (chain 61997); see deployments/studio-next.json.
export const DEFAULT_CONTRACT_ADDRESS = "0x4d580Dc355510e170529473906A455f51610F405" as const;
// The SDK's studioDevnet chain points at studio-dev and has no explorer, so
// Studio Next's endpoints are the defaults for that key.
const STUDIO_NEXT_RPC_URL = "https://studio-next.genlayer.com/api";
const STUDIO_NEXT_EXPLORER_URL = "https://explorer-studio-next.genlayer.com";

export const NETWORK_KEY = chainKey();
export const NETWORK_LABEL = LABELS[NETWORK_KEY];

const base = CHAINS[NETWORK_KEY];
const rpcOverride =
  import.meta.env.VITE_GENLAYER_RPC_URL || (NETWORK_KEY === "studioDevnet" ? STUDIO_NEXT_RPC_URL : undefined);

// The SDK's own chain object carries the consensus contract and fee-policy
// fields writes depend on; only the RPC endpoint is overridden.
export const CHAIN = rpcOverride
  ? { ...base, rpcUrls: { ...base.rpcUrls, default: { http: [rpcOverride] } } }
  : base;

const rawAddress = (import.meta.env.VITE_UPTIMESENTRY_ADDRESS ?? "").trim();
export const CONTRACT_ADDRESS: `0x${string}` = /^0x[0-9a-fA-F]{40}$/.test(rawAddress)
  ? (rawAddress as `0x${string}`)
  : DEFAULT_CONTRACT_ADDRESS;

export const EXPLORER_URL: string | null =
  import.meta.env.VITE_GENLAYER_EXPLORER_URL?.replace(/\/$/, "") ||
  CHAIN.blockExplorers?.default.url ||
  (NETWORK_KEY === "studioDevnet" ? STUDIO_NEXT_EXPLORER_URL : null);

export const CHAIN_ID = CHAIN.id;
export const REPO_URL = "https://github.com/SOBEK96/UptimeSentry";
export const STUDIO_URL = "https://studio-next.genlayer.com";
