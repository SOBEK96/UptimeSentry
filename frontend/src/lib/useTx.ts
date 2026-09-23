import { useCallback, useState } from "react";
import { toast } from "sonner";
import { write, type WriteArgs } from "./contract";
import { explainError } from "./errors";
import { EXPLORER_URL } from "./network";

/** Runs a contract write with a single toast that follows it through
 * wallet confirmation, consensus and the outcome. */
export function useTx(account: `0x${string}` | null, onSettled: () => void) {
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (label: string, fn: string, args: WriteArgs, value: bigint = 0n): Promise<boolean> => {
      if (!account) {
        toast.error("Connect a wallet first.");
        return false;
      }
      setBusy(true);
      const id = toast.loading(label, { description: "Confirm in your wallet" });
      try {
        const hash = await write(account, fn, args, value, {
          onSubmitted: (h) =>
            toast.loading(label, {
              id,
              description: "Submitted. Waiting for validator consensus…",
              action: EXPLORER_URL ? { label: "View", onClick: () => window.open(`${EXPLORER_URL}/tx/${h}`, "_blank", "noopener") } : undefined,
            }),
        });
        toast.success(label, {
          id,
          description: `Accepted · ${hash.slice(0, 10)}…${hash.slice(-6)}`,
          action: EXPLORER_URL ? { label: "View", onClick: () => window.open(`${EXPLORER_URL}/tx/${hash}`, "_blank", "noopener") } : undefined,
        });
        onSettled();
        return true;
      } catch (err) {
        toast.error(`${label} failed`, { id, description: explainError(err) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [account, onSettled],
  );

  return { run, busy };
}
