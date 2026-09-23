import { useCallback, useEffect, useState } from "react";
import { Toaster } from "sonner";
import { views } from "./lib/contract";
import { formatGen } from "./lib/format";
import { CONTRACT_ADDRESS, NETWORK_LABEL } from "./lib/network";
import { useWallet } from "./lib/wallet";
import { useTx } from "./lib/useTx";
import { useSnapshot } from "./lib/useSnapshot";
import { useBalance, useFeeDeposit } from "./lib/useBalance";
import { Header } from "./components/Header";
import { Kpis } from "./components/Kpis";
import { Endpoints } from "./components/Endpoints";
import { Incidents } from "./components/Incidents";
import { Drill } from "./components/Drill";
import { Underwrite } from "./components/Underwrite";
import { HowItWorks } from "./components/HowItWorks";
import { Faq } from "./components/Faq";
import { Footer } from "./components/Footer";
import { Button, Card } from "./components/ui";
import { cx } from "./components/styles";

type Tab = "endpoints" | "incidents" | "drill" | "underwrite";

const TABS: { id: Tab; label: string }[] = [
  { id: "endpoints", label: "Insured endpoints" },
  { id: "incidents", label: "Incidents" },
  { id: "drill", label: "Diagnostic drill" },
  { id: "underwrite", label: "Underwrite" },
];

export default function App() {
  const wallet = useWallet();
  const { data, sync, refresh } = useSnapshot();
  const [tab, setTab] = useState<Tab>("endpoints");
  const [focusProvider, setFocusProvider] = useState<string | null>(null);
  const [claimable, setClaimable] = useState<bigint>(0n);
  const [settled, setSettled] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const balance = useBalance(wallet.address, settled);
  const feeDeposit = useFeeDeposit();

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!CONTRACT_ADDRESS || !wallet.address) return;
    let live = true;
    views
      .claimable(wallet.address)
      .then((v) => live && setClaimable(v))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet.address, settled, data]);

  const onSettled = useCallback(() => {
    setSettled((n) => n + 1);
    void refresh();
  }, [refresh]);
  const tx = useTx(wallet.address, onSettled);

  const openCount = data?.claims.filter((c) => c.status === "CLAIM_PENDING" || c.status === "UNDER_APPEAL").length ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
      <Toaster theme="dark" position="top-right" richColors closeButton toastOptions={{ className: "!font-sans" }} />
      <Header wallet={wallet} balance={balance} sync={sync} onRetry={() => void refresh()} />

      {!CONTRACT_ADDRESS ? (
        <Card className="mt-6 p-8">
          <h2 className="text-lg font-semibold text-white">Point the console at a deployed contract</h2>
          <p className="mt-2 text-sm text-zinc-400">
            Set <code className="font-mono text-emerald-300">VITE_UPTIMESENTRY_ADDRESS</code> to the UptimeSentry contract on {NETWORK_LABEL} and rebuild.
          </p>
        </Card>
      ) : (
        <>
          {wallet.error && <p className="mb-4 text-sm text-amber-300">{wallet.error}</p>}
          <Kpis data={data} now={now} />

          {wallet.address && claimable > 0n && (
            <Card className="mt-4 flex flex-wrap items-center justify-between gap-3 border-emerald-500/30 px-5 py-3">
              <span className="text-sm text-zinc-300">
                You have <span className="font-mono text-emerald-300">{formatGen(claimable)} GEN</span> in returned bonds, rewards or refunds.
              </span>
              <Button size="sm" variant="success" disabled={tx.busy} onClick={() => tx.run("Withdraw", "withdraw", [])}>
                Withdraw
              </Button>
            </Card>
          )}

          <nav aria-label="Sections" className="mt-8 flex gap-1 overflow-x-auto rounded-2xl border border-zinc-800/80 bg-zinc-900/50 p-1 backdrop-blur-md sm:inline-flex">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  setTab(t.id);
                  if (t.id !== "incidents") setFocusProvider(null);
                }}
                aria-current={tab === t.id ? "page" : undefined}
                className={cx(
                  "relative flex h-9 items-center gap-2 whitespace-nowrap rounded-xl px-4 text-sm font-medium transition",
                  tab === t.id ? "bg-zinc-800 text-white shadow-[0_1px_0_0_rgb(255_255_255/0.06)_inset]" : "text-zinc-400 hover:text-zinc-200",
                )}
              >
                {t.label}
                {t.id === "incidents" && openCount > 0 && <span className="rounded-full bg-amber-400/15 px-1.5 font-mono text-[10px] text-amber-300">{openCount}</span>}
              </button>
            ))}
          </nav>

          <main className="mt-5">
            {!data ? (
              <Card className="h-64 animate-pulse" />
            ) : tab === "endpoints" ? (
              <Endpoints
                providers={data.providers}
                account={wallet.address}
                balance={balance}
                feeDeposit={feeDeposit}
                busy={tx.busy}
                onGoUnderwrite={() => setTab("underwrite")}
                onBuy={(p, coverage, term, premium) => tx.run(`Subscribe to ${p.name}`, "purchase_coverage", [p.provider_id, coverage, term], premium)}
                onProbe={(p) => void tx.run(`Probe ${p.name}`, "attest_probe", [p.provider_id])}
                onAddCapital={(p, amount) => tx.run(`Add capital to ${p.name}`, "deposit_underwriting", [p.provider_id], amount)}
                onFileIncident={(p) => {
                  setFocusProvider(p.provider_id);
                  setTab("incidents");
                }}
              />
            ) : tab === "incidents" ? (
              <Incidents
                claims={data.claims}
                policies={data.policies}
                providers={data.providers}
                account={wallet.address}
                now={now}
                busy={tx.busy}
                focusProvider={focusProvider}
                onReport={(pol, prov, trace, bond) => void tx.run("File incident", "file_incident", [pol.policy_id, prov.provider_id, prov.endpoint_url, prov.probe_payload, trace], bond)}
                onAppeal={(c) => void tx.run("Appeal claim", "file_appeal", [c.claim_id], c.required_appeal_bond)}
                onResolve={(c) => void tx.run("Rule on appeal", "resolve_appeal", [c.claim_id])}
                onConfirm={(c) => void tx.run("Record confirmation sample", "confirm_outage", [c.claim_id])}
                onPayout={(c) => void tx.run("Release payout", "claim_payout", [c.claim_id])}
              />
            ) : tab === "drill" ? (
              <Drill policies={data.policies} providers={data.providers} />
            ) : (
              <Underwrite
                busy={tx.busy}
                minPool={data.stats.min_underwriting}
                balance={balance}
                feeDeposit={feeDeposit}
                connected={!!wallet.address}
                onSubmit={async (i) => {
                  const ok = await tx.run(`Register ${i.name}`, "register_provider", [i.name, i.url, i.kind, i.payload, i.maxDowntime, i.targetBps, i.premiumBps], i.pool);
                  if (ok) setTab("endpoints");
                  return ok;
                }}
              />
            )}
          </main>
        </>
      )}

      <div className="mt-20 grid gap-20">
        <HowItWorks />
        <Faq />
      </div>
      <Footer />
    </div>
  );
}
