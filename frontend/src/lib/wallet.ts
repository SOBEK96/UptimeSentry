import { useCallback, useEffect, useState } from "react";
import { CHAIN } from "./network";

export interface Wallet {
  address: `0x${string}` | null;
  chainOk: boolean;
  /** The wallet's current chain id (hex), when a wallet is present. */
  chainId: string | null;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
}

export const chainHex = `0x${CHAIN.id.toString(16)}`;

export function useWallet(): Wallet {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sync = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    try {
      const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
      setAddress((accounts[0] as `0x${string}`) ?? null);
      setChainId((await eth.request({ method: "eth_chainId" })) as string);
    } catch (e) {
      console.warn("[UptimeSentry] wallet state read failed", e);
    }
  }, []);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;
    // Initial read of the injected wallet's state; updates arrive asynchronously.
    // oxlint-disable-next-line react/set-state-in-effect
    void sync();
    const onChange = () => void sync();
    eth.on?.("accountsChanged", onChange);
    eth.on?.("chainChanged", onChange);
    return () => {
      eth.removeListener?.("accountsChanged", onChange);
      eth.removeListener?.("chainChanged", onChange);
    };
  }, [sync]);

  const switchChain = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    setError(null);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
    } catch (switchErr) {
      if (/user rejected|denied/i.test(String((switchErr as Error)?.message ?? switchErr))) {
        setError(`Network switch cancelled. Transactions need ${CHAIN.name}; you can still browse, or continue as a Studio guest.`);
        return;
      }
      try {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: chainHex,
              chainName: CHAIN.name,
              rpcUrls: CHAIN.rpcUrls.default.http,
              nativeCurrency: CHAIN.nativeCurrency,
              blockExplorerUrls: CHAIN.blockExplorers ? [CHAIN.blockExplorers.default.url] : [],
            },
          ],
        });
      } catch (addErr) {
        setError(`Couldn't switch your wallet to ${CHAIN.name} (chain id ${CHAIN.id}): ${addErr instanceof Error ? addErr.message : String(addErr)}`);
        return;
      }
    }
    await sync();
  }, [sync]);

  const connect = useCallback(async () => {
    const eth = window.ethereum;
    setError(null);
    if (!eth) {
      setError("No browser wallet found. Install MetaMask or another EIP-1193 wallet to transact.");
      return;
    }
    setConnecting(true);
    try {
      await eth.request({ method: "eth_requestAccounts" });
      await sync();
      const current = (await eth.request({ method: "eth_chainId" })) as string;
      if (current.toLowerCase() !== chainHex) await switchChain();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }, [sync, switchChain]);

  return {
    address,
    chainOk: chainId?.toLowerCase() === chainHex,
    chainId,
    connecting,
    error,
    connect,
    switchChain,
  };
}
