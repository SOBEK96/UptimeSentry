import { useId, useState, type ReactNode } from "react";
import { Card } from "./ui";
import { cx } from "./styles";

const Code = ({ children }: { children: ReactNode }) => <code className="rounded border border-zinc-800 bg-zinc-950/70 px-1 font-mono text-[0.85em] text-zinc-200">{children}</code>;

const ITEMS: { q: string; a: ReactNode }[] = [
  {
    q: "How does UptimeSentry verify downtime without oracles?",
    a: (
      <>
        The GenVM validators themselves send the provider&apos;s registered probe (a JSON-RPC read such as <Code>eth_blockNumber</Code>, or an HTTP health check) straight to the endpoint. Each validator probes independently and they must agree on the verdict, healthy or failing, before anything is written. No third-party feed or reporter-supplied data decides the outcome.
      </>
    ),
  },
  {
    q: "What happens if an invalid or spoofed endpoint is reported?",
    a: (
      <>
        Evidence is bound to the provider&apos;s registered URL and probe payload. A report naming any other target fails closed with <Code>ERR_UNBOUND_EVIDENCE</Code> and no claim opens. If a report matches the target but the endpoint recovers within the allowed downtime window, an appeal dismisses the claim and the reporter&apos;s bond is forfeited to the provider&apos;s pool.
      </>
    ),
  },
  {
    q: "How are funds protected during a dispute?",
    a: (
      <>
        An accepted claim&apos;s payout is escrowed for a 24-hour challenge window. If anyone appeals in that window, the claim moves to <Code>UNDER_APPEAL</Code> and every payout attempt fails with <Code>ERR_PAYOUT_LOCKED</Code>. It stays locked until a second consensus probe, taken after the provider&apos;s allowed downtime, confirms or dismisses the breach.
      </>
    ),
  },
  {
    q: "What is the Diagnostic SLA Drill?",
    a: (
      <>
        A read-only dry run of filing an incident. It applies the same evidence-binding checks and a live probe of the registered endpoint, then reports the verdict a filing would get right now. It runs as a simulated transaction on a single node, which is never committed, so it never touches provider pools, subscriber balances or bonds, and never opens a claim.
      </>
    ),
  },
];

function Item({ q, a, open, onToggle }: { q: string; a: ReactNode; open: boolean; onToggle: () => void }) {
  const id = useId();
  return (
    <div className="border-b border-zinc-800/80 last:border-b-0">
      <h3>
        <button
          id={`${id}-q`}
          aria-expanded={open}
          aria-controls={`${id}-a`}
          onClick={onToggle}
          className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left text-sm font-medium text-zinc-100 transition hover:bg-zinc-800/30"
        >
          {q}
          <span className={cx("grid size-6 shrink-0 place-items-center rounded-full border transition-all duration-300", open ? "rotate-45 border-emerald-500/50 text-emerald-300" : "border-zinc-700 text-zinc-400")} aria-hidden>
            <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </span>
        </button>
      </h3>
      {/* grid-rows 0fr→1fr animates to the content's natural height without measuring it */}
      <div id={`${id}-a`} role="region" aria-labelledby={`${id}-q`} className={cx("grid transition-[grid-template-rows] duration-300 ease-out", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden" inert={!open}>
          <p className={cx("px-5 pb-5 text-sm leading-relaxed text-zinc-400 transition-opacity duration-300", open ? "opacity-100" : "opacity-0")}>{a}</p>
        </div>
      </div>
    </div>
  );
}

export function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <section aria-labelledby="faq-h" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <div>
        <p className="font-mono text-xs uppercase tracking-widest text-emerald-400/80">FAQ</p>
        <h2 id="faq-h" className="mt-1 text-2xl font-semibold tracking-tight text-white">
          Questions reviewers ask
        </h2>
        <p className="mt-2 text-sm text-zinc-400">
          The full mechanism, error codes and settlement table are in the README.
        </p>
      </div>
      <Card className="overflow-hidden">
        {ITEMS.map((it, i) => (
          <Item key={it.q} q={it.q} a={it.a} open={open === i} onToggle={() => setOpen(open === i ? null : i)} />
        ))}
      </Card>
    </section>
  );
}
