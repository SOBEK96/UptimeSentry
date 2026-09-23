import { CHAIN_ID, CONTRACT_ADDRESS, EXPLORER_URL, NETWORK_LABEL, REPO_URL, STUDIO_URL } from "../lib/network";
import { shortAddr } from "../lib/format";
import { Dot, Mono } from "./ui";

export function Footer() {
  const links = [
    ...(CONTRACT_ADDRESS && EXPLORER_URL ? [{ label: "Contract", detail: shortAddr(CONTRACT_ADDRESS), href: `${EXPLORER_URL}/address/${CONTRACT_ADDRESS}` }] : []),
    { label: "GitHub", detail: "source", href: REPO_URL },
    { label: "GenLayer Studio", detail: "studio-next", href: STUDIO_URL },
  ];
  return (
    <footer className="mt-20 border-t border-zinc-800/80 pt-8">
      <div className="grid items-center gap-6 md:grid-cols-3">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-xl border border-emerald-500/30 bg-emerald-500/10">
            <svg viewBox="0 0 32 32" className="size-5 text-emerald-300" aria-hidden>
              <path d="M3 18h7l3-9 5 15 3-8h8" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-semibold text-white">UptimeSentry</p>
            <p className="text-xs text-zinc-500">Autonomous on-chain SLA insurance powered by GenVM</p>
          </div>
        </div>

        <div className="flex md:justify-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-xs text-zinc-300">
            <Dot tone="emerald" pulse />
            {NETWORK_LABEL} <Mono className="text-zinc-500">(Chain ID: {CHAIN_ID})</Mono>
          </span>
        </div>

        <nav aria-label="Project links" className="flex flex-wrap gap-x-5 gap-y-2 md:justify-end">
          {links.map((l) => (
            <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="group inline-flex items-baseline gap-1.5 text-sm text-zinc-300 transition hover:text-emerald-300">
              {l.label}
              <Mono className="text-[11px] text-zinc-600 group-hover:text-emerald-400/70">{l.detail}</Mono>
              <span aria-hidden className="text-zinc-600 group-hover:text-emerald-400">↗</span>
            </a>
          ))}
        </nav>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-900 pt-5 text-xs text-zinc-600">
        <span>Apache-2.0 / MIT open source protocol</span>
        <span>Figures are read from the contract. Latency is measured from your browser. Payouts, premiums and bonds are native GEN.</span>
      </div>
    </footer>
  );
}
