import type { Snapshot } from "../lib/useSnapshot";
import { formatGen } from "../lib/format";
import { Badge, Card } from "./ui";

function Kpi({ label, value, unit, foot }: { label: string; value: string; unit?: string; foot: React.ReactNode }) {
  return (
    <Card className="flex flex-col gap-3 p-5">
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-mono text-3xl font-medium tracking-tight text-white tabular-nums">{value}</span>
        {unit && <span className="font-mono text-xs text-zinc-500">{unit}</span>}
      </span>
      <div className="flex flex-wrap gap-1.5">{foot}</div>
    </Card>
  );
}

export function Kpis({ data, now }: { data: Snapshot | null; now: number }) {
  if (!data) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="h-[124px] animate-pulse p-5">
            <div className="h-3 w-24 rounded bg-zinc-800" />
            <div className="mt-4 h-7 w-32 rounded bg-zinc-800" />
          </Card>
        ))}
      </div>
    );
  }
  const { stats, providers, policies, claims } = data;
  const accepting = providers.filter((p) => p.accepting).length;
  const inForce = policies.filter((p) => (p.status === "ACTIVE" || p.status === "CLAIM_OPEN") && p.expires_at > now);
  const protectedTvl = inForce.reduce((sum, p) => sum + p.coverage, 0n);
  const confirmed = claims.filter((c) => c.status === "CONFIRMED" || c.status === "PAID").length;
  const dismissed = claims.filter((c) => c.status === "DISMISSED" || c.status === "RECOVERED").length;
  const open = claims.filter((c) => c.status === "CLAIM_PENDING" || c.status === "UNDER_APPEAL").length;

  return (
    <section aria-label="Protocol metrics" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        label="Total underwritten value"
        value={formatGen(stats.total_underwriting, 2)}
        unit="GEN"
        foot={
          <Badge tone={stats.solvent ? "emerald" : "rose"} dot>
            {stats.solvent ? "Ledger balanced" : "Ledger mismatch"}
          </Badge>
        }
      />
      <Kpi
        label="Active insured endpoints"
        value={String(providers.length)}
        foot={<Badge tone={accepting > 0 ? "emerald" : "zinc"} dot>{accepting} selling coverage</Badge>}
      />
      <Kpi
        label="Protected TVL"
        value={formatGen(protectedTvl, 2)}
        unit="GEN"
        foot={<Badge tone={inForce.length ? "sky" : "zinc"}>{inForce.length} {inForce.length === 1 ? "policy" : "policies"} in force</Badge>}
      />
      <Kpi
        label="Resolved SLA incidents"
        value={String(confirmed + dismissed)}
        foot={
          <>
            <Badge tone="emerald">{confirmed} paid out</Badge>
            <Badge tone="rose">{dismissed} dismissed</Badge>
            {open > 0 && <Badge tone="amber" dot pulse>{open} open</Badge>}
          </>
        }
      />
    </section>
  );
}
