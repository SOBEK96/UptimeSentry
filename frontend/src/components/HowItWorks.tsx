import type { ReactNode } from "react";
import { Card, Mono } from "./ui";

interface Step {
  title: string;
  body: string;
  calls: string[];
  accent: string;
  icon: ReactNode;
}

const I = (d: string) => (
  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

const STEPS: Step[] = [
  {
    title: "Capital underwriting",
    body: "Infrastructure providers lock native GEN (10 GEN minimum) behind a public, keyless RPC or API endpoint and set its availability target, allowed downtime and premium.",
    calls: ["register_provider"],
    accent: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
    icon: I("M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7l8-4z"),
  },
  {
    title: "Parametric coverage",
    body: "Teams buy fixed-term policies (1–90 days) against endpoints they depend on. Each policy is fully collateralised: its coverage is reserved from the provider's pool.",
    calls: ["purchase_coverage"],
    accent: "text-sky-300 border-sky-500/30 bg-sky-500/10",
    icon: I("M4 7h16v10H4zM4 11h16M8 15h3"),
  },
  {
    title: "Consensus adjudication",
    body: "When an outage is filed, GenVM validators each probe the endpoint using the exact URL and payload the provider registered, and must agree it is failing before a claim opens.",
    calls: ["file_incident"],
    accent: "text-rose-300 border-rose-500/30 bg-rose-500/10",
    icon: I("M3 12h4l2-6 4 12 2-6h6"),
  },
  {
    title: "Dispute & escrow settlement",
    body: "The payout sits in escrow for a 24h challenge window. An appeal locks it fail-closed until a second consensus probe, after the allowed downtime, rules on the claim.",
    calls: ["file_appeal", "resolve_appeal", "claim_payout"],
    accent: "text-amber-300 border-amber-500/30 bg-amber-500/10",
    icon: I("M7 11V8a5 5 0 0110 0v3M5 11h14v9H5z"),
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-h" className="scroll-mt-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="font-mono text-xs uppercase tracking-widest text-emerald-400/80">Protocol overview</p>
          <h2 id="how-h" className="mt-1 text-2xl font-semibold tracking-tight text-white">
            How it works
          </h2>
        </div>
        <p className="max-w-md text-sm text-zinc-400">Four stages take an endpoint from underwritten to paid out. No oracle sits between the endpoint and the verdict.</p>
      </div>
      <ol className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="relative">
            <Card className="flex h-full flex-col gap-4 p-5">
              <div className="flex items-center justify-between">
                <span className={`grid size-10 place-items-center rounded-xl border ${s.accent}`}>{s.icon}</span>
                <Mono className="text-xs text-zinc-600">step {i + 1}/4</Mono>
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-400">{s.body}</p>
              </div>
              <div className="mt-auto flex flex-wrap gap-1.5 border-t border-zinc-800/80 pt-3">
                {s.calls.map((c) => (
                  <code key={c} className="rounded-md border border-zinc-800 bg-zinc-950/70 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
                    {c}()
                  </code>
                ))}
              </div>
            </Card>
            {i < STEPS.length - 1 && (
              <span aria-hidden className="absolute -right-3 top-1/2 z-10 hidden size-6 -translate-y-1/2 place-items-center rounded-full border border-zinc-800 bg-zinc-950 text-zinc-500 xl:grid">
                <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 3l5 5-5 5" />
                </svg>
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
