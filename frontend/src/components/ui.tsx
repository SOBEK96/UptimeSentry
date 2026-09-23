import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

import { cx, inputClass, type Tone } from "./styles";

export function Card({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <div className={cx("rounded-2xl border border-zinc-800/80 bg-zinc-900/60 shadow-[0_1px_0_0_rgb(255_255_255/0.04)_inset] backdrop-blur-md", className)}>
      {children}
    </div>
  );
}

const TONES: Record<Tone, string> = {
  emerald: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
  amber: "border-amber-500/25 bg-amber-500/10 text-amber-300",
  rose: "border-rose-500/25 bg-rose-500/10 text-rose-300",
  sky: "border-sky-500/25 bg-sky-500/10 text-sky-300",
  zinc: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
};

const DOTS: Record<Tone, string> = {
  emerald: "bg-emerald-400",
  amber: "bg-amber-400",
  rose: "bg-rose-400",
  sky: "bg-sky-400",
  zinc: "bg-zinc-400",
};

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={cx("animate-ping-soft absolute inset-0 rounded-full", DOTS[tone])} />}
      <span className={cx("relative inline-flex size-2 rounded-full", DOTS[tone])} />
    </span>
  );
}

export function Badge({ tone = "zinc", dot, pulse, children, className }: { tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {dot && <Dot tone={tone} pulse={pulse} />}
      {children}
    </span>
  );
}

type Variant = "primary" | "ghost" | "danger" | "success";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-emerald-400 text-zinc-950 hover:bg-emerald-300 shadow-[0_0_24px_-6px_rgb(52_211_153/0.6)]",
  ghost: "border border-zinc-700/80 bg-zinc-900/40 text-zinc-200 hover:border-zinc-500 hover:bg-zinc-800/60",
  danger: "bg-rose-500 text-white hover:bg-rose-400 shadow-[0_0_24px_-8px_rgb(244_63_94/0.7)]",
  success: "bg-emerald-500/15 border border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25",
};

export function Button({ variant = "primary", size = "md", className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none",
        size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm",
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-xs font-medium text-zinc-400">{label}</span>
      {children}
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(inputClass, className)} />;
}

export function GenInput({ className, suffix = "GEN", ...rest }: InputHTMLAttributes<HTMLInputElement> & { suffix?: string }) {
  return (
    <div className="relative">
      <input {...rest} inputMode="decimal" className={cx(inputClass, "pr-16 font-mono", className)} />
      <span className="pointer-events-none absolute inset-y-1.5 right-1.5 flex items-center rounded-lg border border-zinc-700/80 bg-zinc-800/80 px-2 font-mono text-[11px] font-medium text-zinc-300">
        {suffix}
      </span>
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[0.92em]", className)}>{children}</span>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <p className="text-sm font-medium text-zinc-200">{title}</p>
      {children}
    </Card>
  );
}

export function Stat({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd className="mt-1 truncate text-sm text-zinc-200">{children}</dd>
    </div>
  );
}
