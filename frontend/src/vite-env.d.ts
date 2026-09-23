/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_UPTIMESENTRY_ADDRESS?: string;
  readonly VITE_GENLAYER_NETWORK?: string;
  readonly VITE_GENLAYER_RPC_URL?: string;
  readonly VITE_GENLAYER_EXPLORER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  ethereum?: {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    on?(event: string, handler: (...args: unknown[]) => void): void;
    removeListener?(event: string, handler: (...args: unknown[]) => void): void;
  };
}
