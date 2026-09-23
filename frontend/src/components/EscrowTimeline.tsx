import type { Claim } from "../lib/types";
import { formatDuration, formatTime } from "../lib/format";
import {  } from "./ui";
import { cx } from "./styles";

const TONE: Record<Claim["status"], { track: string; text: string; dot: string }> = {
  CLAIM_PENDING: { track: "bg-amber-400", text: "text-amber-300", dot: "border-amber-400" },
  UNDER_APPEAL: { track: "bg-sky-400", text: "text-sky-300", dot: "border-sky-400" },
  CONFIRMED: { track: "bg-emerald-400", text: "text-emerald-300", dot: "border-emerald-400" },
  PAID: { track: "bg-emerald-400", text: "text-emerald-300", dot: "border-emerald-400" },
  DISMISSED: { track: "bg-rose-400", text: "text-rose-300", dot: "border-rose-400" },
  RECOVERED: { track: "bg-rose-400", text: "text-rose-300", dot: "border-rose-400" },
};

// The claim's escrow on a time axis: filing, the provider's allowed downtime
// window, and the challenge deadline, with a live cursor for "now".
export function EscrowTimeline({ claim, now }: { claim: Claim; now: number }) {
  const start = claim.filed_at;
  const end = Math.max(claim.challenge_deadline, start + 1);
  const frac = (t: number) => Math.min(1, Math.max(0, (t - start) / (end - start)));
  const pct = (t: number) => `${frac(t) * 100}%`;
  const tone = TONE[claim.status];
  const locked = claim.status === "UNDER_APPEAL";
  const settled = claim.status === "PAID" || claim.status === "DISMISSED" || claim.status === "RECOVERED" || claim.status === "CONFIRMED";
  const closes = claim.confirmation_closes ?? claim.confirm_after;
  const samples = claim.samples_total ? ` ${claim.samples_down}/${claim.samples_total} samples DOWN so far.` : "";
  const windowClosed = now >= claim.challenge_deadline;

  let caption: string;
  const sampling = now >= claim.confirm_after && now <= closes;
  if (claim.status === "CLAIM_PENDING")
    caption = sampling
      ? `Confirmation window open for ${formatDuration(closes - now)}: record samples to prove the outage is sustained.${samples}`
      : windowClosed && now > closes
        ? `Ready to settle: ${claim.outcome === "SUSTAINED" ? "sustained outage, the payout can be released" : "outage not sustained, the claim will close as recovered"}.`
        : `Payout needs a DOWN majority of samples taken after the allowed downtime, then the challenge deadline.${samples}`;
  else if (locked)
    caption = now > closes ? "Escrow locked. The confirmation window has closed, so the appeal can be ruled on." : `Escrow locked until the appeal is ruled on after ${formatTime(closes)}.${samples}`;
  else if (claim.status === "CONFIRMED") caption = "Breach confirmed by consensus. Payout ready for the insured.";
  else if (claim.status === "DISMISSED") caption = "Outage not sustained across the confirmation window. Claim dismissed.";
  else if (claim.status === "RECOVERED") caption = "Endpoint recovered before the outage became an SLA breach. No payout; escrow returned.";
  else caption = `Paid out ${formatTime(claim.resolved_at || claim.challenge_deadline)}.`;

  return (
    <figure className="m-0">
      <div className="relative mx-2 h-2 rounded-full bg-zinc-800" aria-hidden>
        <div className="absolute inset-y-0 left-0 rounded-l-full bg-rose-500/25" style={{ width: pct(claim.confirm_after) }} />
        <div className={cx("absolute inset-y-0 left-0 rounded-full opacity-70", tone.track)} style={{ width: settled ? "100%" : pct(now) }} />
        {[start, claim.confirm_after].map((t, i) => (
          <span key={i} className={cx("absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-zinc-950", tone.dot)} style={{ left: pct(t) }} />
        ))}
        <span className={cx("absolute top-1/2 grid size-6 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 bg-zinc-950", tone.dot, tone.text)} style={{ left: "100%" }}>
          {locked ? (
            <svg viewBox="0 0 16 16" className="size-3" aria-label="Escrow locked">
              <rect x="3" y="7" width="10" height="7" rx="1.5" fill="currentColor" />
              <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          ) : (
            <span className={cx("size-1.5 rounded-full", tone.track)} />
          )}
        </span>
        {!settled && (
          <span className="absolute -top-2 bottom-[-8px] w-px bg-white/70" style={{ left: pct(now) }}>
            <span className="absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-[10px] text-zinc-300">now</span>
          </span>
        )}
      </div>
      <div className="relative mt-4 flex justify-between font-mono text-[11px] text-zinc-500">
        <span>
          filed
          <br />
          <span className="text-zinc-300">{formatTime(claim.filed_at)}</span>
        </span>
        <span className="absolute hidden -translate-x-1/2 text-center sm:block" style={{ left: pct(claim.confirm_after) }}>
          confirmation window
          <br />
          <span className="text-zinc-300">{formatTime(claim.confirm_after)}</span>
        </span>
        <span className="text-right">
          challenge deadline
          <br />
          <span className="text-zinc-300">{formatTime(claim.challenge_deadline)}</span>
        </span>
      </div>
      <figcaption className={cx("mt-3 text-sm font-medium", tone.text)}>{caption}</figcaption>
    </figure>
  );
}
