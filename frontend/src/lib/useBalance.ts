import { useEffect, useState } from "react";
import { chainReads } from "./contract";

export function useBalance(address: `0x${string}` | null, refreshKey: unknown): bigint | null {
  const [state, setState] = useState<{ address: string; value: bigint } | null>(null);
  useEffect(() => {
    if (!address) return;
    let live = true;
    chainReads
      .balance(address)
      .then((value) => live && setState({ address, value }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [address, refreshKey]);
  return address && state?.address === address ? state.value : null;
}

export function useFeeDeposit(): bigint | null {
  const [fee, setFee] = useState<bigint | null>(null);
  useEffect(() => {
    let live = true;
    chainReads
      .feeDeposit()
      .then((f) => live && setFee(f))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return fee;
}
