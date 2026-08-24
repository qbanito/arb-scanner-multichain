import { AlertCircle } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="quantum-field relative flex min-h-dvh w-full items-center justify-center bg-background text-foreground">
      <div className="quantum-grid" />
      <div className="glass-strong relative z-10 mx-4 w-full max-w-md rounded-2xl p-7">
        <div className="mb-3 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-destructive/12 text-destructive">
            <AlertCircle size={20} />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">404 — Route not found</h1>
        </div>
        <p className="font-mono-tight text-[11px] text-muted-foreground">This page doesn't exist. Head back to the live scanner.</p>
        <a href="/" className="mt-5 inline-flex h-9 items-center rounded-lg bg-primary px-3.5 font-mono-tight text-[11px] font-medium text-primary-foreground transition hover:brightness-110">
          Back to scanner
        </a>
      </div>
    </div>
  );
}
