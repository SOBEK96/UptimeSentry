import { useCallback, useEffect, useState } from "react";
import { CHAIN } from "./network";

export interface Wallet {
  address: `0x${string}` | null;
  chainOk: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  switchChain: () => Promise<void>;
}

const chainHex = `0x${CHAIN.id.toString(16)}`;

export function useWallet(): Wallet {
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sync = useCallback(async () => {
    const eth = window.ethereum;
    if (!eth) return;
    const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
    setAddress((accounts[0] as `0x${string}`) ?? null);
    setChainId((await eth.request({ method: "eth_chainId" })) as string);
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
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
    } catch {
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
    connecting,
    error,
    connect,
    switchChain,
  };
}
