import { useCallback, useState } from "react";
import { toast } from "sonner";
import { write, type WriteArgs } from "./contract";
import { explainError } from "./errors";
import { EXPLORER_URL } from "./network";
import { demo, DEMO_ACCOUNT } from "./demo";

/** Runs a contract write with a single toast that follows it through
 * wallet confirmation, consensus and the outcome. */
export function useTx(account: `0x${string}` | null, onSettled: () => void) {
  const [busy, setBusy] = useState(false);

  // Guest mode: the same contract rules run against sample state in the browser.
  const runDemo = useCallback(
    async (label: string, fn: string, args: WriteArgs, value: bigint): Promise<boolean> => {
      setBusy(true);
      const id = toast.loading(label, { description: "Simulating validator consensus (guest mode)…" });
      try {
        const hash = await demo.write(DEMO_ACCOUNT, fn, args, value);
        toast.success(label, { id, description: `Simulated · ${hash.slice(0, 10)}… · nothing was signed or sent` });
        onSettled();
        return true;
      } catch (err) {
        toast.error(`${label} rejected`, { id, description: explainError(err) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [onSettled],
  );

  const run = useCallback(
    async (label: string, fn: string, args: WriteArgs, value: bigint = 0n): Promise<boolean> => {
      if (demo.get().active) return runDemo(label, fn, args, value);
      if (!account) {
        toast.error("Connect a wallet first.", { description: "Or choose “Try as Studio guest” to explore with simulated transactions." });
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
    [account, onSettled, runDemo],
  );

  return { run, busy };
}
