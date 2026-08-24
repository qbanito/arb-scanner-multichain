import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Route, Switch, Router as WouterRouter, useLocation } from "wouter";
import { AnimatePresence, animate, motion, type Variants } from "framer-motion";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  PolarAngleAxis,
  RadialBar,
  RadialBarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
} from "recharts";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  Clock3,
  Copy,
  ExternalLink,
  Filter,
  Fuel,
  Gauge,
  Layers3,
  Menu,
  RefreshCw,
  Route as RouteIcon,
  Search,
  ShieldCheck,
  ShieldAlert,
  Signal,
  SlidersHorizontal,
  Sparkles,
  Swords,
  TriangleAlert,
  Users,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import {
  getGetScannerOpportunityQueryKey,
  getGetScannerOpportunitiesQueryKey,
  getGetScannerNetworksQueryKey,
  getGetScannerSummaryQueryKey,
  getGetScannerTokensQueryKey,
  getGetScannerAcrossStatusQueryKey,
  getGetScannerAcrossOpportunitiesQueryKey,
  getGetLiquidationOpportunitiesQueryKey,
  getGetLiquidationStrategyDetailQueryKey,
  getHealthCheckQueryKey,
  useGetScannerNetworks,
  useGetScannerAcrossStatus,
  useGetScannerAcrossOpportunities,
  useGetScannerOpportunity,
  useGetScannerOpportunities,
  useGetScannerSummary,
  useGetScannerTokens,
  useGetLiquidationOpportunities,
  useGetLiquidationStrategyDetail,
  useHealthCheck,
} from "@workspace/api-client-react";
import type {
  ArbitrageOpportunity,
  GetScannerOpportunitiesChain,
  NetworkStatus,
  ScannerToken,
  LiquidationOpportunity,
  AcrossStatus,
  AcrossOpportunitySnapshot,
} from "@workspace/api-client-react";
import { QuickDeposit } from "@/components/QuickDeposit";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();
const OPPORTUNITY_REFRESH_MS = 5_000;
const STATUS_REFRESH_MS = 15_000;
const SLOW_DATA_REFRESH_MS = 60_000;
const SCANNER_NETWORK_CONTROLS_URL = "/api/scanner/config/networks";

type ScannerNetworkControls = {
  enabledChains: GetScannerOpportunitiesChain[];
  updatedAt: string;
};

function useScannerNetworkControls() {
  const [data, setData] = useState<ScannerNetworkControls>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let current = true;
    fetch(SCANNER_NETWORK_CONTROLS_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error("Network controls unavailable");
        return (await response.json()) as ScannerNetworkControls;
      })
      .then((controls) => {
        if (current) {
          setData(controls);
          setError(false);
        }
      })
      .catch(() => current && setError(true))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, []);

  const setEnabledChains = async (
    enabledChains: GetScannerOpportunitiesChain[],
  ) => {
    setSaving(true);
    try {
      const response = await fetch(SCANNER_NETWORK_CONTROLS_URL, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabledChains }),
      });
      if (!response.ok) throw new Error("Could not save network controls");
      setData((await response.json()) as ScannerNetworkControls);
      setError(false);
      return true;
    } catch {
      setError(true);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { data, loading, saving, error, setEnabledChains };
}

/* ============================== helpers ============================== */

const money = (value = 0, compact = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: value < 10 ? 2 : 0,
  }).format(value);

const number = (value = 0) => new Intl.NumberFormat("en-US").format(value);
const short = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-4)}`;
const ago = (date?: string) => {
  if (!date) return "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 1000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
};

const MARKET_LABEL: Record<string, string> = {
  main: "Main",
  lido: "Lido",
  etherfi: "EtherFi",
};
const NETWORK_OPTIONS: ReadonlyArray<{
  value: GetScannerOpportunitiesChain;
  label: string;
}> = [
  { value: "all", label: "All 14 networks" },
  { value: "ethereum", label: "Ethereum" },
  { value: "arbitrum", label: "Arbitrum" },
  { value: "optimism", label: "Optimism" },
  { value: "polygon", label: "Polygon" },
  { value: "base", label: "Base" },
  { value: "avalanche", label: "Avalanche" },
  { value: "bsc", label: "BNB Chain" },
  { value: "celo", label: "Celo" },
  { value: "linea", label: "Linea" },
  { value: "mantle", label: "Mantle" },
  { value: "scroll", label: "Scroll" },
  { value: "sonic", label: "Sonic" },
  { value: "zksync", label: "zkSync Era" },
  { value: "soneium", label: "Soneium" },
];

/* ============================ live series =============================
   No history endpoint exists — this hook accumulates REAL values observed
   from live polls into a bounded client-side series. It never fabricates a
   data point: an empty/short chart just means the page hasn't been open
   long enough to have observed more yet. */

type SeriesPoint = { t: number; v: number };

function useLiveSeries(
  value: number | undefined,
  maxPoints = 30,
): SeriesPoint[] {
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  useEffect(() => {
    if (value === undefined || Number.isNaN(value)) return;
    setSeries((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.v === value) return prev;
      const next = [...prev, { t: Date.now(), v: value }];
      return next.length > maxPoints
        ? next.slice(next.length - maxPoints)
        : next;
    });
  }, [value, maxPoints]);
  return series;
}

function AnimatedNumber({
  value,
  format,
}: {
  value: number;
  format: (n: number) => string;
}) {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);
  useEffect(() => {
    const controls = animate(prevRef.current, value, {
      duration: 0.7,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(v),
    });
    prevRef.current = value;
    return () => controls.stop();
  }, [value]);
  return <>{format(display)}</>;
}

function Sparkline({
  data,
  colorVar,
}: {
  data: SeriesPoint[];
  colorVar: string;
}) {
  const gradientId = useId().replace(/:/g, "");
  if (data.length < 2) {
    return (
      <div className="flex h-10 items-center gap-1.5 text-[10px] font-mono-tight text-muted-foreground">
        <span className="dot-live" style={{ width: 4, height: 4 }} /> collecting
        live samples…
      </div>
    );
  }
  const color = `hsl(var(${colorVar}))`;
  return (
    <div className="h-10 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.55} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey="v"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function HealthGauge({
  value,
  liquidatable,
}: {
  value: number;
  liquidatable: boolean;
}) {
  const pct = Math.max(4, Math.min(100, (value / 1.5) * 100));
  const colorVar = liquidatable
    ? "--destructive"
    : value < 1.05
      ? "--warning"
      : "--accent";
  const color = `hsl(var(${colorVar}))`;
  const data = [{ value: pct, fill: color }];
  return (
    <div className="relative h-14 w-14 shrink-0">
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart
          innerRadius="72%"
          outerRadius="100%"
          data={data}
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            cornerRadius={8}
            background={{ fill: "hsl(var(--secondary))" }}
            isAnimationActive={false}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <span
          className="font-mono-tight text-[10px] font-medium"
          style={{ color }}
        >
          {value.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

/* ============================ shared bits ============================= */

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, delay: i * 0.05, ease: "easeOut" },
  }),
};

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

function DataState({
  loading,
  error,
  empty,
  onRetry,
  children,
  label,
}: {
  loading: boolean;
  error: boolean;
  empty: boolean;
  onRetry: () => void;
  children: ReactNode;
  label: string;
}) {
  if (loading) return <Skeleton className="h-48 w-full" />;
  if (error)
    return (
      <div className="glass flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-2xl border-dashed p-8 text-center">
        <TriangleAlert size={18} className="text-primary" />
        <strong className="font-medium">Feed unavailable</strong>
        <span className="font-mono-tight text-[11px] text-muted-foreground">
          Could not reach the {label} stream.
        </span>
        <button
          className="mt-1 inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-secondary/60 px-3 font-mono-tight text-[11px] text-muted-foreground transition hover:border-muted-foreground hover:text-foreground"
          onClick={onRetry}
          data-testid={`button-retry-${label}`}
        >
          <RefreshCw size={13} /> Retry
        </button>
      </div>
    );
  if (empty)
    return (
      <div className="glass flex min-h-[150px] flex-col items-center justify-center gap-2 rounded-2xl border-dashed p-8 text-center">
        <Search size={18} className="text-primary" />
        <strong className="font-medium">No {label} found</strong>
        <span className="font-mono-tight text-[11px] text-muted-foreground">
          Try loosening the active filters.
        </span>
      </div>
    );
  return children;
}

function SectionHeading({
  eyebrow,
  title,
  count,
  note,
  children,
}: {
  eyebrow: string;
  title: string;
  count?: number;
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <div className="font-mono-tight text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          {eyebrow}
        </div>
        <h2 className="mt-1.5 flex items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
          {count !== undefined && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-md bg-primary/12 px-1.5 font-mono-tight text-[10px] text-primary">
              {count}
            </span>
          )}
        </h2>
      </div>
      {note && (
        <span className="flex items-center gap-2 font-mono-tight text-[10px] text-muted-foreground">
          {note}
        </span>
      )}
      {children}
    </div>
  );
}

function ExecBadge({
  active,
  activeLabel,
  idleLabel,
}: {
  active: boolean;
  activeLabel: string;
  idleLabel: string;
}) {
  return (
    <span
      className={`inline-flex w-max items-center gap-1.5 rounded-md px-2 py-1 font-mono-tight text-[9px] uppercase tracking-wide ${
        active ? "bg-accent/12 text-accent" : "bg-warning/12 text-warning"
      }`}
      style={
        !active
          ? {
              color: "hsl(var(--warning))",
              background: "hsl(var(--warning) / 0.12)",
            }
          : undefined
      }
    >
      <span
        className={`dot-live ${active ? "" : "warn"}`}
        style={{ width: 5, height: 5 }}
      />
      {active ? activeLabel : idleLabel}
    </span>
  );
}

function ChainBadge({ chain }: { chain: string }) {
  return (
    <span className="rounded-md border border-border bg-secondary/50 px-1.5 py-0.5 font-mono-tight text-[9px] uppercase tracking-wide text-muted-foreground">
      {chain}
    </span>
  );
}

/* =============================== shell ================================= */

function QuantumBackdrop() {
  return (
    <>
      <div className="quantum-field" />
      <div className="quantum-grid" />
    </>
  );
}

function Mark() {
  return (
    <div
      className="relative grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-primary to-violet-500 shadow-[0_0_20px_hsl(var(--primary)/0.45)]"
      style={{
        background:
          "linear-gradient(135deg, hsl(var(--primary)), hsl(var(--violet)))",
      }}
    >
      <Sparkles size={17} className="text-background" strokeWidth={2.2} />
    </div>
  );
}

function Sidebar({
  mobileOpen,
  close,
}: {
  mobileOpen: boolean;
  close: () => void;
}) {
  const [location] = useLocation();
  const links = [
    { label: "Live scanner", icon: Activity, href: "/" },
    { label: "Opportunities", icon: Zap, href: "/#opportunities" },
    { label: "Liquidations", icon: ShieldAlert, href: "/#liquidations" },
    { label: "Network health", icon: Signal, href: "/#networks" },
    { label: "Token universe", icon: Layers3, href: "/#tokens" },
  ];
  return (
    <>
      {mobileOpen && (
        <button
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm md:hidden"
          onClick={close}
          aria-label="Close navigation"
          data-testid="button-close-navigation"
        />
      )}
      <aside
        className={`glass-strong fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col rounded-r-3xl px-4 py-6 transition-transform duration-300 md:sticky md:top-0 md:h-dvh md:translate-x-0 md:rounded-none md:border-y-0 md:border-l-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Mark />
            <div className="leading-tight">
              <b className="block text-[13px] font-bold tracking-wide">
                ARBITRAGE
              </b>
              <small className="mt-0.5 block font-mono-tight text-[9px] tracking-[0.18em] text-muted-foreground">
                SCANNER / OPS
              </small>
            </div>
          </div>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground md:hidden"
            onClick={close}
            aria-label="Close navigation"
            data-testid="button-close-navigation"
          >
            <X size={16} />
          </button>
        </div>

        <div className="my-6 h-px bg-gradient-to-r from-transparent via-border to-transparent" />
        <div className="px-1 pb-2 font-mono-tight text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Workspace
        </div>
        <nav className="flex flex-col gap-0.5">
          {links.map(({ label, icon: Icon, href }) => {
            const active =
              href === "/" && (location === "/" || location === "");
            return (
              <a
                href={href}
                key={label}
                onClick={close}
                data-testid={`link-${label.toLowerCase().replaceAll(" ", "-")}`}
                className={`group relative flex h-10 items-center gap-3 rounded-xl px-3 text-[12.5px] transition-all ${
                  active
                    ? "bg-secondary text-primary"
                    : "text-sidebar-foreground hover:translate-x-0.5 hover:bg-secondary/60 hover:text-foreground"
                }`}
              >
                {active && (
                  <span className="absolute left-0 h-4 w-[2px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary))]" />
                )}
                <Icon size={16} strokeWidth={1.9} />
                <span>{label}</span>
                {href === "/" && <span className="dot-live ml-auto" />}
              </a>
            );
          })}
        </nav>

        <div className="mt-auto space-y-3">
          <div className="glass rounded-2xl p-3.5">
            <div className="flex items-center gap-2 font-mono-tight text-[10px] text-muted-foreground">
              <span className="dot-live" /> Scanner engine
            </div>
            <div className="mt-2 text-[13px] text-accent">Operational</div>
            <div className="mt-1 font-mono-tight text-[9px] text-muted-foreground">
              live feed every 5s
            </div>
          </div>
          <div className="flex items-center justify-between px-1 font-mono-tight text-[9px] text-muted-foreground">
            <span>v1.0 · quantum</span>
            <CircleHelp size={14} />
          </div>
        </div>
      </aside>
    </>
  );
}

function Topbar({
  onMenu,
  onRefresh,
  refreshing,
}: {
  onMenu: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <header className="glass sticky top-0 z-30 flex h-16 items-center justify-between rounded-none border-x-0 border-t-0 px-4 sm:px-8">
      <div className="flex items-center gap-3">
        <button
          className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground md:hidden"
          onClick={onMenu}
          aria-label="Open navigation"
          data-testid="button-open-navigation"
        >
          <Menu size={18} />
        </button>
        <div className="hidden items-center gap-2 font-mono-tight text-[11px] text-muted-foreground sm:flex">
          <span>Markets</span>
          <ChevronRight size={13} />
          <b className="font-medium text-foreground">Live scanner</b>
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-4">
        <div className="hidden items-center gap-2 font-mono-tight text-[10px] text-muted-foreground lg:flex">
          <span className="dot-live" /> API connected
        </div>
        <button
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-secondary/60 px-3 font-mono-tight text-[11px] text-muted-foreground transition hover:border-muted-foreground hover:text-foreground disabled:opacity-50"
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="button-refresh-all"
        >
          <RefreshCw size={13} className={refreshing ? "spin" : ""} />{" "}
          <span className="hidden sm:inline">Refresh</span>
        </button>
        <div
          className="grid h-8 w-8 place-items-center rounded-full border border-border bg-gradient-to-br from-primary/25 to-violet-500/25 font-mono-tight text-[10px]"
          style={{
            background:
              "linear-gradient(135deg, hsl(var(--primary)/0.25), hsl(var(--violet)/0.25))",
          }}
        >
          QT
        </div>
      </div>
    </header>
  );
}

/* ============================== hero/stats ============================== */

function Hero({
  healthOk,
  healthError,
}: {
  healthOk: boolean;
  healthError: boolean;
}) {
  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="show"
      className="mb-10 flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-end"
    >
      <div>
        <div className="font-mono-tight text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Market intelligence /{" "}
          <span className="text-foreground/70">
            {new Date().toLocaleDateString("en-US", {
              weekday: "short",
              month: "short",
              day: "numeric",
            })}
          </span>
        </div>
        <h1 className="mt-3 text-[38px] font-semibold leading-[0.98] tracking-tight sm:text-5xl lg:text-[64px]">
          Find the gap
          <br />
          <span className="brand-gradient text-glow">before it closes.</span>
        </h1>
        <p className="mt-3 max-w-md text-sm text-muted-foreground">
          Multi-network price intelligence, atomic route discovery, liquidation
          risk and Aave market coverage — for the moments that matter.
        </p>
      </div>
      <div className="glass flex items-center gap-3 rounded-2xl px-4 py-3">
        <span
          className={`dot-live ${healthOk ? "" : healthError ? "risk" : "warn"}`}
        />
        <div className="font-mono-tight text-[11px]">
          <div
            style={{
              color: healthOk
                ? "hsl(var(--accent))"
                : healthError
                  ? "hsl(var(--destructive))"
                  : "hsl(var(--warning))",
            }}
          >
            {healthOk
              ? "All systems nominal"
              : healthError
                ? "API degraded"
                : "Checking engine"}
          </div>
          <div className="text-muted-foreground">
            UTC{" "}
            {new Date().toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

type SummaryData = {
  activeOpportunities: number;
  poolsScanned: number;
  tokensTracked: number;
  estimatedNetProfit24h: number;
  lastScanAt: string;
  scanLatencyMs: number;
  candidatesDiscovered: number;
  routableCandidates: number;
  routesQuoted: number;
  routesUnavailable: number;
  routeCoveragePct: number;
  quoteCoveragePct: number;
  exactQuotePositive: number;
  grossProfitPositive: number;
  netProfitPositive: number;
  readyForSimulation: number;
};

function StatCard({
  index,
  label,
  value,
  raw,
  format,
  colorVar,
  icon: Icon,
  sub,
  loading,
}: {
  index: number;
  label: string;
  value: number;
  raw?: number;
  format: (n: number) => string;
  colorVar: string;
  icon: typeof Zap;
  sub: string;
  loading: boolean;
}) {
  const series = useLiveSeries(raw ?? value);
  return (
    <motion.div
      variants={fadeUp}
      custom={index}
      initial="hidden"
      animate="show"
      className="glow-ring glass relative overflow-hidden rounded-2xl p-4 transition-transform hover:-translate-y-0.5 sm:p-5"
    >
      <div className="flex items-start justify-between">
        <div
          className="grid h-9 w-9 place-items-center rounded-xl"
          style={{
            color: `hsl(var(${colorVar}))`,
            background: `hsl(var(${colorVar}) / 0.12)`,
          }}
        >
          <Icon size={16} />
        </div>
      </div>
      <div className="mt-4 font-mono-tight text-[11px] text-muted-foreground">
        {label}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-28" />
      ) : (
        <div
          className="mt-1 font-mono-tight text-[26px] font-medium tracking-tight"
          data-testid={`metric-${label.toLowerCase().replaceAll(" ", "-")}`}
        >
          <AnimatedNumber value={value} format={format} />
        </div>
      )}
      <div className="mt-3 font-mono-tight text-[10px] text-muted-foreground">
        {sub}
      </div>
      <div className="-mx-1 -mb-1 mt-3">
        <Sparkline data={series} colorVar={colorVar} />
      </div>
    </motion.div>
  );
}

function Summary({ loading, data }: { loading: boolean; data?: SummaryData }) {
  const items = [
    {
      label: "Active opportunities",
      value: data?.activeOpportunities ?? 0,
      format: (v: number) => number(Math.round(v)),
      colorVar: "--primary",
      icon: Zap,
      sub: "scanner candidates",
    },
    {
      label: "Est. net profit · 24h",
      value: data?.estimatedNetProfit24h ?? 0,
      format: (v: number) => money(v, true),
      colorVar: "--accent",
      icon: WalletCards,
      sub: "after fees + gas",
    },
    {
      label: "Pools scanned",
      value: data?.poolsScanned ?? 0,
      format: (v: number) => number(Math.round(v)),
      colorVar: "--violet",
      icon: Layers3,
      sub: "across all networks",
    },
    {
      label: "Route coverage",
      value: data?.routeCoveragePct ?? 0,
      format: (v: number) => `${v.toFixed(1)}%`,
      colorVar: "--accent",
      icon: ShieldCheck,
      sub: data
        ? `${data.routableCandidates}/${data.candidatesDiscovered} complete routes · ${data.routesQuoted} exact quotes`
        : "awaiting route diagnostics",
    },
    {
      label: "Scan latency",
      value: data?.scanLatencyMs ?? 0,
      format: (v: number) => `${Math.round(v)}ms`,
      colorVar: "--warning",
      icon: Gauge,
      sub: data ? `last scan ${ago(data.lastScanAt)}` : "awaiting scan",
    },
  ];
  return (
    <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
      {items.map((item, i) => (
        <StatCard key={item.label} index={i} loading={loading} {...item} />
      ))}
    </div>
  );
}

function OpportunityFunnel({ data }: { data?: SummaryData }) {
  const stages = [
    ["Raw", data?.candidatesDiscovered ?? 0],
    ["Closed", data?.routableCandidates ?? 0],
    ["Exact quote", data?.routesQuoted ?? 0],
    ["Before gas +", data?.exactQuotePositive ?? 0],
    ["Net +", data?.netProfitPositive ?? 0],
    ["Ready for simulation", data?.readyForSimulation ?? 0],
  ] as const;
  return (
    <section className="mb-8 rounded-2xl border border-border/70 bg-card/45 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-4">
        <div>
          <div className="font-mono-tight text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Profitability funnel</div>
          <div className="mt-1 font-mono-tight text-[12px] text-foreground">Live evidence, not synthetic positives</div>
        </div>
        <div className="font-mono-tight text-[9px] text-muted-foreground">final simulation runs in executor</div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {stages.map(([label, value], index) => (
          <div key={label} className="rounded-xl border border-border/60 bg-background/30 px-3 py-2.5">
            <div className="font-mono-tight text-[9px] uppercase text-muted-foreground">{index + 1}. {label}</div>
            <div className="mt-1 font-mono-tight text-lg text-foreground">{number(value)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityChart({
  opportunities,
  profit24h,
}: {
  opportunities: number | undefined;
  profit24h: number | undefined;
}) {
  const opSeries = useLiveSeries(opportunities);
  const profitSeries = useLiveSeries(profit24h);
  const merged = useMemo(() => {
    const byTime = new Map<
      number,
      { t: number; opportunities?: number; profit?: number }
    >();
    opSeries.forEach((p) =>
      byTime.set(p.t, {
        ...(byTime.get(p.t) ?? { t: p.t }),
        opportunities: p.v,
      }),
    );
    profitSeries.forEach((p) =>
      byTime.set(p.t, { ...(byTime.get(p.t) ?? { t: p.t }), profit: p.v }),
    );
    return [...byTime.values()].sort((a, b) => a.t - b.t);
  }, [opSeries, profitSeries]);

  return (
    <motion.div
      variants={fadeUp}
      initial="hidden"
      animate="show"
      className="glass mb-10 rounded-2xl p-5 sm:p-6"
    >
      <div className="mb-1 flex items-center justify-between">
        <div>
          <div className="font-mono-tight text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
            Session telemetry
          </div>
          <h3 className="mt-1 text-base font-medium">
            Live activity, as observed
          </h3>
        </div>
        <span className="hidden font-mono-tight text-[10px] text-muted-foreground sm:inline">
          Builds up in real time — no history endpoint is faked
        </span>
      </div>
      {merged.length < 2 ? (
        <div className="flex h-[180px] items-center justify-center gap-2 font-mono-tight text-[11px] text-muted-foreground">
          <span className="dot-live" /> Watching the feed — chart appears once a
          second sample lands
        </div>
      ) : (
        <div className="h-[180px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={merged}
              margin={{ top: 10, right: 10, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="hsl(var(--accent))"
                    stopOpacity={0.4}
                  />
                  <stop
                    offset="100%"
                    stopColor="hsl(var(--accent))"
                    stopOpacity={0}
                  />
                </linearGradient>
                <linearGradient id="opFill" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="hsl(var(--primary))"
                    stopOpacity={0.35}
                  />
                  <stop
                    offset="100%"
                    stopColor="hsl(var(--primary))"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border) / 0.5)"
                vertical={false}
              />
              <XAxis
                dataKey="t"
                tickFormatter={(t) =>
                  new Date(t).toLocaleTimeString("en-US", {
                    hour12: false,
                    minute: "2-digit",
                    second: "2-digit",
                  })
                }
                stroke="hsl(var(--muted-foreground))"
                fontSize={9}
                tickLine={false}
                axisLine={false}
                minTickGap={40}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 10,
                  fontSize: 11,
                  fontFamily: "var(--app-font-mono)",
                }}
                labelFormatter={(t) =>
                  new Date(t as number).toLocaleTimeString()
                }
                formatter={(v: number, key: string) => [
                  key === "profit" ? money(v, true) : number(v),
                  key === "profit" ? "Net profit 24h" : "Opportunities",
                ]}
              />
              <Area
                type="monotone"
                dataKey="profit"
                stroke="hsl(var(--accent))"
                strokeWidth={2}
                fill="url(#profitFill)"
                connectNulls
                isAnimationActive={false}
              />
              <Area
                type="monotone"
                dataKey="opportunities"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                fill="url(#opFill)"
                connectNulls
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </motion.div>
  );
}

/* ============================== network pulse ============================== */

function NetworkStrip({
  data,
  loading,
  error,
  retry,
}: {
  data?: NetworkStatus[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}) {
  return (
    <section id="networks" className="mb-14 scroll-mt-20">
      <SectionHeading
        eyebrow="Infrastructure"
        title="Network pulse"
        note={
          <>
            <span className="dot-live" /> Live blocks
          </>
        }
      />
      <DataState
        loading={loading}
        error={error}
        empty={!data?.length}
        onRetry={retry}
        label="networks"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {data?.map((network, i) => {
            const gasPct = Math.min(100, (network.gasGwei / 80) * 100);
            return (
              <motion.div
                variants={fadeUp}
                custom={i}
                initial="hidden"
                animate="show"
                key={network.id}
                className="glow-ring glass rounded-2xl p-4"
                data-testid={`card-network-${network.id}`}
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-full bg-primary/12 font-mono-tight text-[11px] font-medium text-primary">
                    {network.name.slice(0, 1)}
                  </div>
                  <div>
                    <b className="block text-[13px] font-medium">
                      {network.name}
                    </b>
                    <small className="mt-0.5 block font-mono-tight text-[9px] text-muted-foreground">
                      Chain {network.chainId}
                    </small>
                  </div>
                  <span
                    className="ml-auto flex items-center gap-1.5 rounded-md px-2 py-1 font-mono-tight text-[9px] uppercase"
                    style={{
                      color:
                        network.status === "healthy"
                          ? "hsl(var(--accent))"
                          : network.status === "degraded"
                            ? "hsl(var(--warning))"
                            : "hsl(var(--destructive))",
                      background:
                        network.status === "healthy"
                          ? "hsl(var(--accent) / 0.1)"
                          : network.status === "degraded"
                            ? "hsl(var(--warning) / 0.1)"
                            : "hsl(var(--destructive) / 0.1)",
                    }}
                  >
                    <span className="h-[5px] w-[5px] rounded-full bg-current" />
                    {network.status}
                  </span>
                </div>
                <div className="mt-5 grid grid-cols-3 gap-2.5">
                  <div>
                    <small className="mb-1.5 block font-mono-tight text-[9px] text-muted-foreground">
                      Block
                    </small>
                    <b className="font-mono-tight text-[13px]">
                      {number(network.blockNumber)}
                    </b>
                  </div>
                  <div>
                    <small className="mb-1.5 block font-mono-tight text-[9px] text-muted-foreground">
                      Gas
                    </small>
                    <b className="font-mono-tight text-[13px]">
                      {network.gasGwei.toFixed(1)}{" "}
                      <em className="text-[9px] font-normal not-italic text-muted-foreground">
                        gwei
                      </em>
                    </b>
                  </div>
                  <div>
                    <small className="mb-1.5 block font-mono-tight text-[9px] text-muted-foreground">
                      Pools
                    </small>
                    <b className="font-mono-tight text-[13px]">
                      {number(network.pools)}
                    </b>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <Fuel size={11} className="text-muted-foreground" />
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${gasPct}%`,
                        background:
                          gasPct > 66
                            ? "hsl(var(--destructive))"
                            : gasPct > 33
                              ? "hsl(var(--warning))"
                              : "hsl(var(--accent))",
                      }}
                    />
                  </div>
                </div>
                <div className="mt-3.5 flex justify-between border-t border-border pt-2.5 font-mono-tight text-[9px] text-muted-foreground">
                  <span>{network.blockTimeMs}ms block time</span>
                  <span>{ago(network.lastBlockAt)}</span>
                </div>
              </motion.div>
            );
          })}
        </div>
      </DataState>
    </section>
  );
}

function NetworkControls({
  controls,
  loading,
  saving,
  error,
  onChange,
}: {
  controls?: ScannerNetworkControls;
  loading: boolean;
  saving: boolean;
  error: boolean;
  onChange: (enabledChains: GetScannerOpportunitiesChain[]) => Promise<void>;
}) {
  const enabled = new Set(controls?.enabledChains ?? []);
  const selectableNetworks = NETWORK_OPTIONS.filter(
    (network) => network.value !== "all",
  );
  return (
    <section className="mb-10 rounded-2xl border border-border bg-card/50 p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="font-mono-tight text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
            Scan controls
          </div>
          <h3 className="mt-1 text-sm font-medium">Active blockchains</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Disabled networks are not queried for pools, RPC data, or exact quotes.
          </p>
        </div>
        <span className="font-mono-tight text-[10px] text-primary">
          {loading ? "Loading…" : `${enabled.size} active`}
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {selectableNetworks.map((network) => {
          const active = enabled.has(network.value);
          const lastActive = active && enabled.size === 1;
          return (
            <button
              key={network.value}
              type="button"
              disabled={saving || loading || lastActive}
              onClick={() => {
                const next = active
                  ? [...enabled].filter((chain) => chain !== network.value)
                  : [...enabled, network.value];
                void onChange(next);
              }}
              className={`rounded-lg border px-2.5 py-1.5 font-mono-tight text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                active
                  ? "border-primary/45 bg-primary/12 text-primary"
                  : "border-border bg-background text-muted-foreground hover:border-primary/35"
              }`}
              aria-pressed={active}
              title={lastActive ? "Keep at least one blockchain active" : undefined}
            >
              <span className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${active ? "bg-primary" : "bg-muted-foreground/50"}`} />
              {network.label}
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="mt-3 font-mono-tight text-[10px] text-warning">
          Could not save the scanner network controls. Try again.
        </p>
      ) : null}
    </section>
  );
}

function AcrossMission({
  data,
  snapshot,
  loading,
  error,
  retry,
}: {
  data?: AcrossStatus;
  snapshot?: AcrossOpportunitySnapshot;
  loading: boolean;
  error: boolean;
  retry: () => void;
}) {
  return (
    <section className="mb-14">
      <SectionHeading
        eyebrow="Cross-chain mission"
        title="Across relay layer"
        note={<span className="font-mono-tight text-[9px] uppercase">Quote-first</span>}
      />
      <DataState
        loading={loading}
        error={error}
        empty={!data}
        onRetry={retry}
        label="Across integration"
      >
        {data && (
          <div className="glass grid gap-4 rounded-2xl p-5 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <div className="flex items-center gap-2">
                <span className={`dot-live ${data.enabled ? "" : "bg-warning"}`} />
                <b className="text-sm font-medium">
                  {data.enabled ? "Across quote layer online" : "Across not configured"}
                </b>
                <span className="rounded-md border border-border px-2 py-1 font-mono-tight text-[9px] uppercase text-muted-foreground">
                  {data.executionMode}
                </span>
              </div>
              <p className="mt-2 max-w-3xl text-xs leading-5 text-muted-foreground">
                Compara rutas entre cadenas y descuenta bridge, gas de ambos lados,
                slippage e inventario. El relay no se marca ejecutable hasta reconciliar
                los fondos en destino.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-right font-mono-tight text-[10px] text-muted-foreground">
              <span>API key <b className={data.apiKeyConfigured ? "text-accent" : "text-warning"}>{data.apiKeyConfigured ? "ready" : "missing"}</b></span>
              <span>Integrator <b className={data.integratorIdConfigured ? "text-accent" : "text-warning"}>{data.integratorIdConfigured ? "ready" : "missing"}</b></span>
              <span className="col-span-2">Chains {data.allowedChainIds.length || "dynamic"}</span>
            </div>
          </div>
        )}
        {snapshot?.configurationMissing.length ? (
          <div className="mt-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 font-mono-tight text-[10px] text-warning">
            Continuous cross-chain scan waiting for: {snapshot.configurationMissing.join(", ")}
          </div>
        ) : null}
        {snapshot ? (
          <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl border border-border bg-card/30 px-4 py-3 font-mono-tight text-[10px] text-muted-foreground sm:grid-cols-4">
            <span>Scanner <b className={snapshot.continuous ? "text-accent" : "text-warning"}>{snapshot.continuous ? "running" : "waiting"}</b></span>
            <span>Networks <b className="text-foreground">{snapshot.chainsScanned.length}/{data?.allowedChainIds.length ?? 0}</b></span>
            <span>Quotes <b className="text-foreground">{snapshot.opportunities.length}</b></span>
            <span>Failures <b className={snapshot.quoteFailures ? "text-warning" : "text-accent"}>{snapshot.quoteFailures}</b></span>
          </div>
        ) : null}
        {snapshot?.opportunities.length ? (
          <div className="mt-3 overflow-x-auto rounded-2xl border border-border bg-card/40">
            <table className="w-full min-w-[760px] text-left font-mono-tight text-[10px]">
              <thead className="border-b border-border text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-normal">Token / route</th>
                  <th className="px-4 py-3 font-normal">Spread</th>
                  <th className="px-4 py-3 font-normal">Net profit</th>
                  <th className="px-4 py-3 font-normal">Fill</th>
                  <th className="px-4 py-3 text-right font-normal">State</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.opportunities.slice(0, 8).map((opportunity) => (
                  <tr key={opportunity.id} className="border-b border-border/60 last:border-0">
                    <td className="px-4 py-3">
                      <b className="text-foreground">{opportunity.token}</b>
                      <span className="ml-2 text-muted-foreground">{opportunity.originChain} → {opportunity.destinationChain}</span>
                    </td>
                    <td className="px-4 py-3 text-foreground">{(opportunity.spreadBps / 100).toFixed(2)}%</td>
                    <td className={`px-4 py-3 ${opportunity.profitable ? "text-accent" : "text-warning"}`}>
                      {opportunity.netProfitUsd === undefined ? "—" : money(opportunity.netProfitUsd)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{opportunity.expectedFillTimeSeconds ? `${opportunity.expectedFillTimeSeconds}s` : "—"}</td>
                    <td className="px-4 py-3 text-right text-warning">watch-only</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : snapshot && !snapshot.configurationMissing.length ? (
          <div className="mt-3 rounded-xl border border-border bg-card/30 px-4 py-4 font-mono-tight text-[10px] text-muted-foreground">
            No corroborated cross-chain route yet. The relay is continuing to scan and will populate this table after an Across quote passes price validation.
          </div>
        ) : null}
      </DataState>
    </section>
  );
}

/* ============================== opportunities ============================== */

function venueVersionLabel(venue: ArbitrageOpportunity["buyVenue"]) {
  const version = venue.labels?.find((label) => /^v\d/i.test(label));
  return `${venue.name}${version ? ` ${version.toUpperCase()}` : ""}`;
}

function OpportunityCard({
  item,
  index,
  onSelect,
}: {
  item: ArbitrageOpportunity;
  index: number;
  onSelect: (o: ArbitrageOpportunity) => void;
}) {
  const evaluated = item.quoteStatus === "quoted";
  const inactiveLabel =
    item.quoteStatus === "estimated"
      ? "Quote queued"
      : item.quoteStatus === "unavailable"
        ? "Unavailable"
        : item.executionBlocker === "below-minimum-size"
          ? "Capital too small"
          : item.executionBlocker === "insufficient-liquidity"
            ? "Liquidity too low"
        : item.executionBlocker === "negative-net"
          ? "No profit"
          : item.executionBlocker === "target-not-allowed"
            ? "Target blocked"
          : item.executorDeployed === false
            ? "Watch-only"
            : "Monitoring";
  const routeVenueLabel = item.routeLegs?.length
    ? item.routeLegs.map((leg) => venueVersionLabel(leg.venue)).join(" → ")
    : `${venueVersionLabel(item.buyVenue)} · ${item.buyVenue.feeBps}bps → ${venueVersionLabel(item.sellVenue)} · ${item.sellVenue.feeBps}bps`;
  return (
    <motion.button
      variants={fadeUp}
      custom={index}
      initial="hidden"
      animate="show"
      whileHover={{ y: -3 }}
      onClick={() => onSelect(item)}
      className="glow-ring glass group flex flex-col rounded-2xl p-4 text-left transition-colors hover:border-primary/40 sm:p-5"
      data-testid={`row-opportunity-${item.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-full bg-primary/12 font-mono-tight text-[11px] font-medium text-primary">
            {item.token.slice(0, 2)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <strong className="font-mono-tight text-[13px] font-medium">
                {item.token}
              </strong>
              <ChainBadge chain={item.chain} />
            </div>
            <small className="mt-0.5 block font-mono-tight text-[10px] text-muted-foreground">
              {item.pair}
            </small>
          </div>
        </div>
        <ExecBadge
          active={item.executable}
          activeLabel="Route eligible"
          idleLabel={inactiveLabel}
        />
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-border/70 bg-background/30 px-3 py-2.5 font-mono-tight text-[10.5px] text-muted-foreground">
        <span className="truncate text-foreground/90">{routeVenueLabel}</span>
        {item.routeLegs?.length ? (
          <span className="ml-auto shrink-0 text-primary">
            {item.routeLegs.length}-hop
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex items-end justify-between">
        <div>
          <div className="font-mono-tight text-[9px] uppercase tracking-wide text-muted-foreground">
            Net profit
          </div>
          <div className="font-mono-tight text-lg font-medium text-accent">
            {evaluated ? money(item.profit.netProfitUsd) : "—"}
          </div>
          <div className="font-mono-tight text-[9px] text-muted-foreground">
            {evaluated
              ? `on ${money(item.profit.recommendedBorrowUsd, true)}`
              : item.quoteStatus === "estimated"
                ? item.executionBlocker === "below-minimum-size"
                  ? "capacity below viable size"
                  : item.executionBlocker === "insufficient-liquidity"
                    ? "pool liquidity below route floor"
                    : "awaiting exact quote"
                : item.executionBlocker === "quote-failed"
                  ? "exact quote failed"
                  : "route not closed"}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono-tight text-[9px] uppercase tracking-wide text-muted-foreground">
            Spread
          </div>
          <div className="font-mono-tight text-sm font-medium">
            {item.spreadPct.toFixed(2)}%
          </div>
          <div className="font-mono-tight text-[9px] text-muted-foreground">
            {item.spreadBps} bps
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3 font-mono-tight text-[9px] text-muted-foreground">
        <span>{ago(item.detectedAt)}</span>
        <span className="flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
          Details <ChevronRight size={12} />
        </span>
      </div>
    </motion.button>
  );
}

function NearMisses({ data }: { data?: ArbitrageOpportunity[] }) {
  const misses = useMemo(
    () =>
      (data ?? [])
        .filter(
          (item) =>
            item.quoteStatus === "quoted" &&
            item.profit.grossProfitUsd > 0 &&
            item.profit.netProfitUsd <= 0,
        )
        .sort((a, b) => b.profit.netProfitUsd - a.profit.netProfitUsd)
        .slice(0, 4),
    [data],
  );
  const quoteBottlenecks = useMemo(() => {
    const counts = new Map<string, { adapter: string; reason: string; count: number }>();
    for (const item of data ?? []) {
      if (item.executionBlocker !== "quote-failed") continue;
      const adapter = item.quoteFailureAdapter ?? "unknown adapter";
      const reason = item.quoteFailureReason ?? "no diagnostic returned";
      const key = `${adapter}:${reason}`;
      const previous = counts.get(key);
      counts.set(key, { adapter, reason, count: (previous?.count ?? 0) + 1 });
    }
    return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 4);
  }, [data]);
  return (
    <section className="mb-5 rounded-2xl border border-warning/25 bg-warning/5 p-4 sm:p-5">
      <div className="font-mono-tight text-[10px] uppercase tracking-[0.14em] text-warning">Top near-misses</div>
      <div className="mt-1 font-mono-tight text-[11px] text-muted-foreground">Exact quotes with positive gross return, ranked by distance to net profitability.</div>
      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        {misses.length ? misses.map((item, index) => (
          <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/35 px-3 py-2.5 font-mono-tight">
            <div className="min-w-0">
              <div className="truncate text-[11px] text-foreground">#{index + 1} {item.pair}</div>
              <div className="mt-1 truncate text-[9px] text-muted-foreground">{venueVersionLabel(item.buyVenue)} → {venueVersionLabel(item.sellVenue)}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[10px] text-foreground">gross {money(item.profit.grossProfitUsd)}</div>
              <div className="mt-1 text-[10px] text-warning">net {money(item.profit.netProfitUsd)}</div>
            </div>
          </div>
        )) : (
          <div className="rounded-xl border border-border/60 bg-background/35 px-3 py-3 font-mono-tight text-[10px] text-muted-foreground lg:col-span-2">
            No exact quoted near-miss in this snapshot. The funnel above shows whether this is due to quote coverage or no gross-positive routes.
          </div>
        )}
      </div>
      <div className="mt-4 border-t border-border/60 pt-3">
        <div className="font-mono-tight text-[9px] uppercase tracking-wide text-muted-foreground">Exact-quote bottlenecks</div>
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          {quoteBottlenecks.length ? quoteBottlenecks.map((failure) => (
            <div key={`${failure.adapter}:${failure.reason}`} className="rounded-xl border border-border/60 bg-background/35 px-3 py-2.5 font-mono-tight">
              <div className="text-[10px] text-foreground">{failure.adapter} · {failure.count} routes</div>
              <div className="mt-1 line-clamp-2 text-[9px] text-muted-foreground">{failure.reason}</div>
            </div>
          )) : (
            <div className="font-mono-tight text-[9px] text-muted-foreground">No adapter failures in this snapshot.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function Opportunities({
  data,
  loading,
  error,
  retry,
  onSelect,
  chain,
  onChainChange,
  enabledChains,
}: {
  data?: ArbitrageOpportunity[];
  loading: boolean;
  error: boolean;
  retry: () => void;
  onSelect: (opportunity: ArbitrageOpportunity) => void;
  chain: GetScannerOpportunitiesChain;
  onChainChange: (chain: GetScannerOpportunitiesChain) => void;
  enabledChains: GetScannerOpportunitiesChain[];
}) {
  const [minBps, setMinBps] = useState("0");
  const filtered = useMemo(
    () => (data ?? []).filter((item) => item.spreadBps >= Number(minBps)),
    [data, minBps],
  );
  return (
    <section id="opportunities" className="mb-14 scroll-mt-20">
      <SectionHeading
        eyebrow="Opportunity feed"
        title="Screened market dislocations"
        count={filtered.length}
      >
        <div className="flex gap-2">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5">
            <Filter size={13} className="text-muted-foreground" />
            <select
              value={chain}
              onChange={(event) =>
                onChainChange(
                  event.target.value as GetScannerOpportunitiesChain,
                )
              }
              data-testid="select-chain-filter"
              className="cursor-pointer border-0 bg-transparent py-2 font-mono-tight text-[10px] text-muted-foreground outline-none"
            >
              {NETWORK_OPTIONS.filter(
                (network) =>
                  network.value === "all" || enabledChains.includes(network.value),
              ).map((network) => (
                <option key={network.value} value={network.value}>
                  {network.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5">
            <SlidersHorizontal size={13} className="text-muted-foreground" />
            <select
              value={minBps}
              onChange={(event) => setMinBps(event.target.value)}
              data-testid="select-spread-filter"
              className="cursor-pointer border-0 bg-transparent py-2 font-mono-tight text-[10px] text-muted-foreground outline-none"
            >
              <option value="0">Any spread</option>
              <option value="25">25+ bps</option>
              <option value="50">50+ bps</option>
              <option value="100">100+ bps</option>
            </select>
          </div>
        </div>
      </SectionHeading>
      <DataState
        loading={loading}
        error={error}
        empty={!filtered.length}
        onRetry={retry}
        label="opportunities"
      >
        <NearMisses data={filtered} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((item, i) => (
            <OpportunityCard
              key={item.id}
              item={item}
              index={i}
              onSelect={onSelect}
            />
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-2 font-mono-tight text-[9px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <span className="dot-live" /> Streaming from {data?.length ?? 0}{" "}
            active routes
          </span>
          <span className="flex items-center gap-1.5">
            Sorted by net profit <ArrowDownRight size={12} />
          </span>
        </div>
      </DataState>
    </section>
  );
}

/* ============================== liquidations ============================== */

function StrategyCheck({ label, ok }: { label: string; ok: boolean | null }) {
  const StatusIcon =
    ok === true ? CircleCheck : ok === false ? CircleX : CircleDashed;
  const color =
    ok === true
      ? "hsl(var(--accent))"
      : ok === false
        ? "hsl(var(--destructive))"
        : "hsl(var(--muted-foreground))";
  return (
    <div
      className="flex items-center gap-1.5 font-mono-tight text-[9.5px]"
      style={{ color }}
    >
      <StatusIcon size={12} className="shrink-0" />
      <span className="truncate">{label}</span>
    </div>
  );
}

function StrategyPanel({
  strategy,
}: {
  strategy: LiquidationOpportunity["strategy"];
}) {
  const blockedReasons = [
    !strategy.executorDeployed
      ? "no ArbExecutor contract deployed on this chain yet"
      : null,
    strategy.aaveLiquiditySufficient === false
      ? "Aave doesn't have enough of the debt asset to flash-loan right now"
      : null,
  ].filter((r): r is string => r !== null);

  return (
    <div className="mt-4 rounded-xl border border-border/70 bg-background/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-mono-tight text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
          Strategy
        </span>
        <span className="flex items-center gap-1 font-mono-tight text-[9px] text-primary">
          Route, gas &amp; competitors <ChevronRight size={11} />
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <StrategyCheck label="Executor" ok={strategy.executorDeployed} />
        <StrategyCheck
          label="Aave liquidity"
          ok={strategy.aaveLiquiditySufficient}
        />
      </div>
      {blockedReasons.length > 0 && (
        <div
          className="mt-2.5 flex items-start gap-1.5 border-t border-border/60 pt-2.5 font-mono-tight text-[9px]"
          style={{ color: "hsl(var(--destructive))" }}
        >
          <TriangleAlert size={11} className="mt-0.5 shrink-0" />
          <span>{blockedReasons[0]}</span>
        </div>
      )}
    </div>
  );
}

function LiquidationCard({
  item,
  index,
  onSelect,
}: {
  item: LiquidationOpportunity;
  index: number;
  onSelect: (o: LiquidationOpportunity) => void;
}) {
  return (
    <motion.div
      variants={fadeUp}
      custom={index}
      initial="hidden"
      animate="show"
      whileHover={{ y: -3 }}
      onClick={() => onSelect(item)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(item)}
      className="glow-ring glass cursor-pointer rounded-2xl p-4 sm:p-5"
      data-testid={`row-liquidation-${item.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <HealthGauge
            value={item.healthFactor}
            liquidatable={item.liquidatable}
          />
          <div>
            <strong className="font-mono-tight text-[12.5px] font-medium">
              {short(item.userAddress)}
            </strong>
            <div className="mt-1 flex items-center gap-1.5">
              <ChainBadge chain={item.chain} />
              <span
                className="rounded-md border border-violet-500/25 px-1.5 py-0.5 font-mono-tight text-[9px] uppercase tracking-wide text-violet-300"
                style={{
                  borderColor: "hsl(var(--violet) / 0.3)",
                  color: "hsl(var(--violet))",
                }}
              >
                {MARKET_LABEL[item.market] ?? item.market}
              </span>
            </div>
          </div>
        </div>
        <ExecBadge
          active={item.liquidatable}
          activeLabel="Liquidatable"
          idleLabel="Monitoring"
        />
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl border border-border/70 bg-background/30 px-3 py-2.5 font-mono-tight text-[10.5px]">
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase text-muted-foreground">Debt</div>
          <div className="truncate text-foreground/90">
            {item.debt.symbol} · {money(item.debt.amountUsd, true)}
          </div>
        </div>
        <ArrowRight size={12} className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1 text-right">
          <div className="text-[9px] uppercase text-muted-foreground">
            Collateral
          </div>
          <div className="truncate text-foreground/90">
            {item.collateral.symbol} · {money(item.collateral.amountUsd, true)}
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-end justify-between">
        <div>
          <div className="font-mono-tight text-[9px] uppercase tracking-wide text-muted-foreground">
            Est. bonus
          </div>
          <div className="font-mono-tight text-lg font-medium text-accent">
            {money(item.estimatedBonusUsd)}
          </div>
          <div className="font-mono-tight text-[9px] text-muted-foreground">
            {item.liquidationBonusPct.toFixed(1)}% protocol bonus
          </div>
        </div>
        <div className="text-right font-mono-tight text-[9px] text-muted-foreground">
          {ago(item.detectedAt)}
        </div>
      </div>

      <StrategyPanel strategy={item.strategy} />
    </motion.div>
  );
}

function RiskHistogram({ data }: { data?: LiquidationOpportunity[] }) {
  const buckets = useMemo(() => {
    const ranges = [
      { label: "≤1.00", test: (hf: number) => hf <= 1.0 },
      { label: "1.00–1.02", test: (hf: number) => hf > 1.0 && hf <= 1.02 },
      { label: "1.02–1.05", test: (hf: number) => hf > 1.02 && hf <= 1.05 },
      { label: "1.05+", test: (hf: number) => hf > 1.05 },
    ];
    return ranges.map((r) => ({
      label: r.label,
      count: (data ?? []).filter((d) => r.test(d.healthFactor)).length,
    }));
  }, [data]);
  if (!data?.length) return null;
  return (
    <div className="glass mb-5 rounded-2xl p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className="font-mono-tight text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
          Risk distribution, right now
        </div>
        <span className="font-mono-tight text-[9px] text-muted-foreground">
          by Health Factor bucket
        </span>
      </div>
      <div className="h-[110px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={buckets}
            margin={{ top: 4, right: 4, bottom: 0, left: -20 }}
          >
            <XAxis
              dataKey="label"
              stroke="hsl(var(--muted-foreground))"
              fontSize={10}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ fill: "hsl(var(--secondary) / 0.5)" }}
              contentStyle={{
                background: "hsl(var(--popover))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 10,
                fontSize: 11,
                fontFamily: "var(--app-font-mono)",
              }}
            />
            <Bar
              dataKey="count"
              radius={[6, 6, 0, 0]}
              fill="hsl(var(--destructive))"
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Liquidations({
  data,
  loading,
  error,
  retry,
  onSelect,
}: {
  data?: LiquidationOpportunity[];
  loading: boolean;
  error: boolean;
  retry: () => void;
  onSelect: (o: LiquidationOpportunity) => void;
}) {
  return (
    <section id="liquidations" className="mb-14 scroll-mt-20">
      <SectionHeading
        eyebrow="Aave V3 · Main / Lido / EtherFi"
        title="Liquidation risk"
        count={data?.length ?? 0}
        note="Health Factor read live on-chain, per position"
      />
      <DataState
        loading={loading}
        error={error}
        empty={!data?.length}
        onRetry={retry}
        label="liquidation opportunities"
      >
        <RiskHistogram data={data} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data?.map((item, i) => (
            <LiquidationCard
              key={item.id}
              item={item}
              index={i}
              onSelect={onSelect}
            />
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-2 font-mono-tight text-[9px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <span className="dot-live" /> Streaming from Aave V3 subgraphs +
            live Health Factor
          </span>
          <span>Sorted by estimated bonus, highest first</span>
        </div>
      </DataState>
    </section>
  );
}

/* ============================== token universe ============================== */

function TokenUniverse({
  data,
  loading,
  error,
  retry,
}: {
  data?: ScannerToken[];
  loading: boolean;
  error: boolean;
  retry: () => void;
}) {
  const top = data?.slice(0, 8) ?? [];
  const maxLiquidity = Math.max(1, ...top.map((t) => t.liquidityUsd));
  return (
    <section id="tokens" className="mb-14 scroll-mt-20">
      <SectionHeading
        eyebrow="Coverage"
        title="Token universe"
        note={`${data?.length ?? 0} tracked assets`}
      />
      <DataState
        loading={loading}
        error={error}
        empty={!data?.length}
        onRetry={retry}
        label="tokens"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {top.map((token, i) => (
            <motion.div
              variants={fadeUp}
              custom={i}
              initial="hidden"
              animate="show"
              whileHover={{ y: -3 }}
              key={token.address}
              className="glow-ring glass rounded-2xl p-4"
              data-testid={`card-token-${token.symbol}`}
            >
              <div className="flex items-center gap-2.5">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-primary/12 font-mono-tight text-[11px] font-medium text-primary">
                  {token.symbol.slice(0, 2)}
                </div>
                <div className="min-w-0">
                  <strong className="block truncate font-mono-tight text-[12px] font-medium">
                    {token.symbol}
                  </strong>
                  <small className="block truncate font-mono-tight text-[9px] text-muted-foreground">
                    {token.name}
                  </small>
                </div>
                <span
                  className="ml-auto shrink-0 font-mono-tight text-[10px]"
                  style={{
                    color:
                      token.change24h >= 0
                        ? "hsl(var(--accent))"
                        : "hsl(var(--destructive))",
                  }}
                >
                  {token.change24h >= 0 ? "+" : ""}
                  {token.change24h.toFixed(2)}%
                </span>
              </div>
              <div className="mt-4 font-mono-tight text-lg">
                {money(token.priceUsd, false)}
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-primary to-violet-400"
                  style={{
                    width: `${Math.max(4, (token.liquidityUsd / maxLiquidity) * 100)}%`,
                    background:
                      "linear-gradient(90deg, hsl(var(--primary)), hsl(var(--violet)))",
                  }}
                />
              </div>
              <div className="mt-2.5 flex justify-between gap-1 border-t border-border pt-2.5 font-mono-tight text-[9px] text-muted-foreground">
                <span>{money(token.liquidityUsd, true)} liq.</span>
                <span>{token.pools} pools</span>
                <span>{token.chains.length} chains</span>
              </div>
            </motion.div>
          ))}
        </div>
      </DataState>
    </section>
  );
}

/* ============================== detail drawer ============================== */

function DetailDrawer({
  selected,
  close,
}: {
  selected: ArbitrageOpportunity | null;
  close: () => void;
}) {
  const detail = useGetScannerOpportunity(selected?.id ?? "", {
    query: {
      enabled: Boolean(selected?.id),
      queryKey: getGetScannerOpportunityQueryKey(selected?.id ?? ""),
      refetchInterval: selected?.id ? OPPORTUNITY_REFRESH_MS : false,
    },
  });
  const item = detail.data ?? selected;
  const evaluated = Boolean(item && item.quoteStatus === "quoted");
  const protocolCount = item
    ? new Set(
        item.routeLegs?.length
          ? item.routeLegs.map((leg) => leg.venue.dexId.toLowerCase())
          : [
              item.buyVenue.dexId.toLowerCase(),
              item.sellVenue.dexId.toLowerCase(),
            ],
      ).size
    : 0;
  const inactiveLabel =
    item?.quoteStatus === "estimated"
      ? "Quote queued"
      : item?.quoteStatus === "unavailable"
        ? "Unavailable"
        : item?.executionBlocker === "negative-net"
          ? "No profit"
          : item?.executionBlocker === "target-not-allowed"
            ? "Target blocked"
          : item?.executorDeployed === false
            ? "Watch-only"
            : "Monitoring";
  const [executionState, setExecutionState] = useState<
    "idle" | "confirm" | "sending" | "queued" | "error"
  >("idle");

  useEffect(() => setExecutionState("idle"), [selected?.id]);

  const requestExecution = async () => {
    if (!item?.executable || executionState !== "confirm") {
      setExecutionState("confirm");
      return;
    }
    setExecutionState("sending");
    try {
      const response = await fetch(
        `/api/scanner/opportunities/${encodeURIComponent(item.id)}/execute`,
        { method: "POST" },
      );
      if (!response.ok)
        throw new Error(
          (await response.json().catch(() => null))?.error ??
            `HTTP ${response.status}`,
        );
      setExecutionState("queued");
    } catch {
      setExecutionState("error");
    }
  };
  return (
    <AnimatePresence>
      {selected && (
        <div
          className="fixed inset-0 z-[60] flex justify-end"
          role="dialog"
          aria-modal="true"
        >
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={close}
            aria-label="Close opportunity detail"
            data-testid="button-close-detail"
          />
          <motion.aside
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
            className="glass-strong relative w-full max-w-[440px] overflow-y-auto rounded-l-3xl p-6 shadow-[-20px_0_60px_rgba(0,0,0,0.4)] sm:p-7"
          >
            <div className="mb-6 flex items-start justify-between">
              <div>
                <div className="font-mono-tight text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Route detail
                </div>
                <h2 className="mt-1.5 text-xl font-semibold tracking-tight">
                  {item?.token} / {item?.pair}
                </h2>
              </div>
              <button
                className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
                onClick={close}
                aria-label="Close detail"
                data-testid="button-close-detail"
              >
                <X size={17} />
              </button>
            </div>

            {detail.isLoading ? (
              <>
                <Skeleton className="h-28 w-full" />
                <Skeleton className="mt-3 h-48 w-full" />
              </>
            ) : item ? (
              <>
                <div className="flex items-end gap-6 rounded-2xl border border-border bg-secondary/30 p-4">
                  <div>
                    <span className="font-mono-tight text-[9px] text-muted-foreground">
                      {evaluated
                        ? "Complete-route net profit"
                        : "Executable net profit"}
                    </span>
                    <strong className="mt-1.5 block font-mono-tight text-2xl text-accent">
                      {evaluated ? money(item.profit.netProfitUsd) : "—"}
                    </strong>
                  </div>
                  <div>
                    <span className="font-mono-tight text-[9px] text-muted-foreground">
                      Spread
                    </span>
                    <strong className="mt-1.5 block font-mono-tight text-2xl text-primary">
                      {item.spreadPct.toFixed(2)}%
                    </strong>
                    <small className="font-mono-tight text-[9px] text-muted-foreground">
                      {item.spreadBps} basis points
                    </small>
                  </div>
                  <ExecBadge
                    active={item.executable}
                    activeLabel="Route eligible"
                    idleLabel={inactiveLabel}
                  />
                </div>

                {item.routeKind && (
                  <div className="mt-2 font-mono-tight text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
                    {item.routeKind === "multi-hop"
                      ? "Atomic multi-hop cycle"
                      : item.routeKind === "triangular"
                        ? "Atomic triangular cycle"
                        : item.routeKind === "cross-stable"
                          ? "Atomic cross-stable cycle"
                          : "Atomic two-pool cycle"}
                    {item.routeLegs?.length
                      ? ` · ${item.routeLegs.length} swaps`
                      : ""}
                    {` · ${protocolCount} protocol${protocolCount === 1 ? "" : "s"}`}
                  </div>
                )}

                {item.routeLegs?.length ? (
                  <div className="my-6 grid gap-2">
                    {item.routeLegs.map((leg, index) => (
                      <div
                        className="grid grid-cols-[28px_1fr_auto] items-center gap-2 rounded-xl border border-border p-3"
                        key={`${leg.venue.pairAddress}-${index}`}
                      >
                        <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 font-mono-tight text-[10px] text-primary">
                          {index + 1}
                        </span>
                        <div>
                          <strong className="block font-mono-tight text-[11px]">
                            {leg.tokenInSymbol} → {leg.tokenOutSymbol}
                          </strong>
                          <small className="font-mono-tight text-[9px] text-muted-foreground">
                            {venueVersionLabel(leg.venue)} · {leg.venue.feeBps}
                            bps
                          </small>
                        </div>
                        <small className="font-mono-tight text-[9px] text-muted-foreground">
                          {leg.venue.liquidityUsd > 0
                            ? `${money(leg.venue.liquidityUsd, true)} liq.`
                            : ""}
                        </small>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="my-6 grid grid-cols-[1fr_36px_1fr] items-center gap-2">
                    <div
                      className="rounded-xl border border-border border-l-2 p-3.5"
                      style={{ borderLeftColor: "hsl(var(--primary))" }}
                    >
                      <span className="font-mono-tight text-[9px] text-muted-foreground">
                        BUY
                      </span>
                      <strong className="mt-1.5 block font-mono-tight text-[12.5px] font-medium">
                        {venueVersionLabel(item.buyVenue)}
                      </strong>
                      <small className="font-mono-tight text-[9px] text-muted-foreground">
                        {money(item.buyVenue.priceUsd)} · {item.buyVenue.feeBps}{" "}
                        bps fee
                      </small>
                    </div>
                    <div className="grid place-items-center text-primary">
                      <Zap size={16} />
                    </div>
                    <div
                      className="rounded-xl border border-border border-l-2 p-3.5"
                      style={{ borderLeftColor: "hsl(var(--accent))" }}
                    >
                      <span className="font-mono-tight text-[9px] text-muted-foreground">
                        SELL
                      </span>
                      <strong className="mt-1.5 block font-mono-tight text-[12.5px] font-medium">
                        {venueVersionLabel(item.sellVenue)}
                      </strong>
                      <small className="font-mono-tight text-[9px] text-muted-foreground">
                        {money(item.sellVenue.priceUsd)} ·{" "}
                        {item.sellVenue.feeBps} bps fee
                      </small>
                    </div>
                  </div>
                )}

                <div className="border-y border-border py-4">
                  <div className="mb-3 font-mono-tight text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                    Profit estimate
                  </div>
                  {(
                    [
                      ["Gross profit", item.profit.grossProfitUsd],
                      ["Flash loan fee", -item.profit.flashLoanFeeUsd],
                      ["Gas cost", -item.profit.gasCostUsd],
                      ["DEX fees", -item.profit.dexFeesUsd],
                      ["Slippage", -item.profit.slippageUsd],
                    ] as const
                  ).map(([label, value]) => (
                    <div
                      className="my-2.5 flex justify-between font-mono-tight text-[11px] text-muted-foreground"
                      key={label}
                    >
                      <span>{label}</span>
                      <b
                        className={
                          value < 0
                            ? "text-muted-foreground"
                            : "font-medium text-foreground"
                        }
                      >
                        {value < 0 ? "−" : ""}
                        {money(Math.abs(value))}
                      </b>
                    </div>
                  ))}
                  <div className="mt-3.5 flex justify-between border-t border-border pt-3.5 text-foreground">
                    <span className="font-mono-tight text-[11px]">
                      Executable net profit
                    </span>
                    <b className="font-mono-tight text-sm text-accent">
                      {evaluated
                        ? money(item.profit.netProfitUsd)
                        : item.quoteStatus === "estimated"
                          ? "Awaiting exact quote"
                          : item.executionBlocker === "quote-failed"
                            ? "Exact quote failed"
                            : "Not a closed route"}
                    </b>
                  </div>
                </div>

                <div className="grid gap-2.5 py-4 font-mono-tight text-[10.5px] text-muted-foreground">
                  {item.executionBlocker === "quote-budget" && (
                    <div className="rounded-lg border border-primary/30 bg-primary/5 p-2.5 text-primary">
                      The cycle is structurally closed and ranked, but is
                      waiting for an exact on-chain quote slot. It is not
                      executable yet.
                    </div>
                  )}
                  {(item.executionBlocker === "quote-failed" ||
                    item.executionBlocker === "unsupported-or-open-route") && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-warning">
                      Exact on-chain quoting failed or a verified
                      adapter/closing leg is missing. No profit is assumed.
                    </div>
                  )}
                  {item.executionBlocker === "negative-net" && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-warning">
                      Complete on-chain quote: the route loses money after the
                      configured safety buffer, flash-loan premium, and gas.
                    </div>
                  )}
                  {item.executionBlocker === "target-not-allowed" && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-warning">
                      The route is profitable by exact quote, but at least one
                      token contract is not authorized by the on-chain
                      executor. It will not be submitted or spend gas.
                    </div>
                  )}
                  {item.executionBlocker === "executor-not-deployed" && (
                    <div className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-warning">
                      Exact quote monitoring only: this chain still needs an
                      ArbExecutor deployment before orders can be sent.
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Clock3 size={13} className="text-primary" /> Detected{" "}
                    {ago(item.detectedAt)}
                  </div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck size={13} className="text-primary" />{" "}
                    Confidence:{" "}
                    <b className="text-foreground">{item.profit.confidence}</b>
                  </div>
                  <div className="flex items-center gap-2">
                    <Activity size={13} className="text-primary" /> Block{" "}
                    {number(item.blockNumber)}
                  </div>
                </div>

                <QuickDeposit
                  chainId={item.chainId}
                  executorDeployed={item.executorDeployed === true}
                />

                <div className="flex gap-2">
                  <button
                    className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-accent font-mono-tight text-[11px] font-medium text-accent-foreground transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={requestExecution}
                    disabled={
                      !item.executable ||
                      executionState === "sending" ||
                      executionState === "queued"
                    }
                    data-testid="button-execute-opportunity"
                  >
                    <Swords size={13} />
                    {executionState === "confirm"
                      ? "Confirm execution"
                      : executionState === "sending"
                        ? "Validating…"
                        : executionState === "queued"
                          ? "Queued"
                          : executionState === "error"
                            ? "Retry execution"
                            : "Execute now"}
                  </button>
                  <a
                    className="flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-3 font-mono-tight text-[11px] font-medium text-primary-foreground transition hover:brightness-110"
                    href={item.buyVenue.dexUrl}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="link-open-buy-venue"
                  >
                    <ExternalLink size={13} /> Open route
                  </a>
                  <button
                    className="flex h-10 items-center gap-2 rounded-xl border border-border bg-secondary/60 px-3.5 font-mono-tight text-[11px] text-muted-foreground transition hover:text-foreground"
                    onClick={() => navigator.clipboard?.writeText(item.id)}
                    data-testid="button-copy-opportunity"
                  >
                    <Copy size={13} /> Copy ID
                  </button>
                </div>
              </>
            ) : (
              <div className="glass rounded-2xl p-8 text-center text-sm text-muted-foreground">
                Opportunity no longer available.
              </div>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

/* ======================== liquidation detail drawer ======================== */

function LiquidationDetailDrawer({
  selected,
  close,
}: {
  selected: LiquidationOpportunity | null;
  close: () => void;
}) {
  const params = {
    chainId: selected?.chainId ?? 0,
    poolAddress: selected?.poolAddress ?? "",
    debtAssetAddress: selected?.debt.address ?? "",
    collateralAssetAddress: selected?.collateral.address ?? "",
    debtAmount: selected?.debt.amount ?? "0",
    collateralAmount: selected?.collateral.amount ?? "0",
    estimatedBonusUsd: selected?.estimatedBonusUsd ?? 0,
  };
  const detail = useGetLiquidationStrategyDetail(params, {
    query: {
      enabled: Boolean(selected),
      queryKey: getGetLiquidationStrategyDetailQueryKey(params),
    },
  });
  const item = selected;

  const blockedReasons = item
    ? [
        !item.strategy.executorDeployed
          ? "No ArbExecutor contract deployed on this chain yet."
          : null,
        item.strategy.aaveLiquiditySufficient === false
          ? "Aave doesn't have enough of the debt asset to flash-loan right now."
          : null,
        detail.data?.routeBuildable === false
          ? detail.data.routeBlockedReason
          : null,
      ].filter((r): r is string => r !== null)
    : [];

  return (
    <AnimatePresence>
      {item && (
        <div
          className="fixed inset-0 z-[60] flex justify-end"
          role="dialog"
          aria-modal="true"
        >
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={close}
            aria-label="Close liquidation detail"
            data-testid="button-close-liquidation-detail"
          />
          <motion.aside
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.28, ease: "easeOut" }}
            className="glass-strong relative w-full max-w-[440px] overflow-y-auto rounded-l-3xl p-6 shadow-[-20px_0_60px_rgba(0,0,0,0.4)] sm:p-7"
          >
            <div className="mb-6 flex items-start justify-between">
              <div>
                <div className="font-mono-tight text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  Liquidation detail
                </div>
                <h2 className="mt-1.5 font-mono-tight text-lg font-semibold tracking-tight">
                  {short(item.userAddress)}
                </h2>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <ChainBadge chain={item.chain} />
                  <span
                    className="rounded-md border px-1.5 py-0.5 font-mono-tight text-[9px] uppercase tracking-wide"
                    style={{
                      borderColor: "hsl(var(--violet) / 0.3)",
                      color: "hsl(var(--violet))",
                    }}
                  >
                    {MARKET_LABEL[item.market] ?? item.market}
                  </span>
                </div>
              </div>
              <button
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
                onClick={close}
                aria-label="Close detail"
                data-testid="button-close-liquidation-detail-x"
              >
                <X size={17} />
              </button>
            </div>

            <div className="flex items-end gap-6 rounded-2xl border border-border bg-secondary/30 p-4">
              <HealthGauge
                value={item.healthFactor}
                liquidatable={item.liquidatable}
              />
              <div>
                <span className="font-mono-tight text-[9px] text-muted-foreground">
                  Health Factor
                </span>
                <strong
                  className="mt-1.5 block font-mono-tight text-2xl"
                  style={{
                    color: item.liquidatable
                      ? "hsl(var(--destructive))"
                      : "hsl(var(--warning))",
                  }}
                >
                  {item.healthFactor.toFixed(4)}
                </strong>
              </div>
              <ExecBadge
                active={item.liquidatable}
                activeLabel="Liquidatable"
                idleLabel="Monitoring"
              />
            </div>

            <div className="my-6 grid grid-cols-[1fr_36px_1fr] items-center gap-2">
              <div
                className="rounded-xl border border-border border-l-2 p-3.5"
                style={{ borderLeftColor: "hsl(var(--destructive))" }}
              >
                <span className="font-mono-tight text-[9px] text-muted-foreground">
                  DEBT TO COVER
                </span>
                <strong className="mt-1.5 block font-mono-tight text-[12.5px] font-medium">
                  {item.debt.symbol}
                </strong>
                <small className="font-mono-tight text-[9px] text-muted-foreground">
                  {money(item.debt.amountUsd, true)}
                </small>
              </div>
              <div className="grid place-items-center text-primary">
                <ArrowRight size={16} />
              </div>
              <div
                className="rounded-xl border border-border border-l-2 p-3.5"
                style={{ borderLeftColor: "hsl(var(--accent))" }}
              >
                <span className="font-mono-tight text-[9px] text-muted-foreground">
                  COLLATERAL SEIZED
                </span>
                <strong className="mt-1.5 block font-mono-tight text-[12.5px] font-medium">
                  {item.collateral.symbol}
                </strong>
                <small className="font-mono-tight text-[9px] text-muted-foreground">
                  {money(item.collateral.amountUsd, true)}
                </small>
              </div>
            </div>

            <div className="border-y border-border py-4">
              <div className="mb-3 font-mono-tight text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                Profit estimate
              </div>
              <div className="my-2.5 flex justify-between font-mono-tight text-[11px] text-muted-foreground">
                <span>Est. bonus ({item.liquidationBonusPct.toFixed(1)}%)</span>
                <b className="font-medium text-foreground">
                  {money(item.estimatedBonusUsd)}
                </b>
              </div>
              <div className="my-2.5 flex justify-between font-mono-tight text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Fuel size={12} /> Gas cost
                </span>
                <b className="font-medium text-foreground">
                  {detail.isLoading
                    ? "…"
                    : detail.data?.estimatedGasCostUsd !== null &&
                        detail.data?.estimatedGasCostUsd !== undefined
                      ? money(detail.data.estimatedGasCostUsd)
                      : "—"}
                </b>
              </div>
              <div className="mt-3.5 flex justify-between border-t border-border pt-3.5 text-foreground">
                <span className="font-mono-tight text-[11px]">Net profit</span>
                <b
                  className="font-mono-tight text-sm"
                  style={{
                    color:
                      (detail.data?.estimatedNetProfitUsd ?? 0) >= 0
                        ? "hsl(var(--accent))"
                        : "hsl(var(--destructive))",
                  }}
                >
                  {detail.isLoading
                    ? "calculating…"
                    : detail.data?.estimatedNetProfitUsd !== null &&
                        detail.data?.estimatedNetProfitUsd !== undefined
                      ? money(detail.data.estimatedNetProfitUsd)
                      : "unknown — gas cost unavailable"}
                </b>
              </div>
              {detail.data?.gasCostBasis && (
                <div className="mt-1.5 font-mono-tight text-[9px] text-muted-foreground">
                  {detail.data.gasCostBasis}
                </div>
              )}
            </div>

            <div className="border-b border-border py-4">
              <div className="mb-3 flex items-center gap-1.5 font-mono-tight text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                <RouteIcon size={12} /> Execution readiness
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <StrategyCheck
                  label="Executor deployed"
                  ok={item.strategy.executorDeployed}
                />
                <StrategyCheck
                  label="Aave liquidity"
                  ok={item.strategy.aaveLiquiditySufficient}
                />
                <StrategyCheck
                  label="Swap route buildable"
                  ok={
                    detail.isLoading
                      ? null
                      : (detail.data?.routeBuildable ?? null)
                  }
                />
              </div>
              {item.strategy.aaveLiquidityAvailableUsd !== null && (
                <div className="mt-2.5 font-mono-tight text-[9.5px] text-muted-foreground">
                  Available in Aave right now:{" "}
                  <b className="text-foreground">
                    {money(item.strategy.aaveLiquidityAvailableUsd, true)}
                  </b>
                </div>
              )}
              {blockedReasons.length > 0 ? (
                <div className="mt-2.5 flex flex-col gap-1.5 border-t border-border/60 pt-2.5">
                  {blockedReasons.map((reason) => (
                    <div
                      key={reason}
                      className="flex items-start gap-1.5 font-mono-tight text-[9.5px]"
                      style={{ color: "hsl(var(--destructive))" }}
                    >
                      <TriangleAlert size={11} className="mt-0.5 shrink-0" />
                      <span>{reason}</span>
                    </div>
                  ))}
                </div>
              ) : !detail.isLoading && detail.data ? (
                <div className="mt-2.5 flex items-center gap-1.5 border-t border-border/60 pt-2.5 font-mono-tight text-[9.5px] text-accent">
                  <CircleCheck size={11} /> No known blockers — capturable if it
                  crosses HF 1.0
                </div>
              ) : null}
            </div>

            <div className="py-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 font-mono-tight text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                  <Swords size={12} /> Competition — last 30 days
                </div>
                {!detail.isLoading && detail.data && (
                  <span className="font-mono-tight text-[9px] text-muted-foreground">
                    {detail.data.sampleCount} liquidations seen
                  </span>
                )}
              </div>
              {detail.isLoading ? (
                <>
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="mt-1.5 h-8 w-full" />
                </>
              ) : detail.data && detail.data.topCompetitors.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {detail.data.topCompetitors.map((c, i) => (
                    <div
                      key={c.liquidator}
                      className="flex items-center justify-between rounded-lg border border-border/60 bg-background/30 px-3 py-2 font-mono-tight text-[10.5px]"
                    >
                      <span className="flex items-center gap-2 text-muted-foreground">
                        <Users
                          size={12}
                          className={
                            i === 0
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }
                        />
                        {short(c.liquidator)}
                      </span>
                      <b className="text-foreground">{c.count}×</b>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-border/60 bg-background/30 px-3 py-3 text-center font-mono-tight text-[9.5px] text-muted-foreground">
                  No liquidations recorded on this market in the lookback window
                  — no active competitors identified.
                </div>
              )}
            </div>

            <button
              className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-border bg-secondary/60 font-mono-tight text-[11px] text-muted-foreground transition hover:text-foreground"
              onClick={() => navigator.clipboard?.writeText(item.userAddress)}
              data-testid="button-copy-liquidation-address"
            >
              <Copy size={13} /> Copy borrower address
            </button>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

/* =================================== cockpit =================================== */

function Cockpit() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [selected, setSelected] = useState<ArbitrageOpportunity | null>(null);
  const [selectedLiquidation, setSelectedLiquidation] =
    useState<LiquidationOpportunity | null>(null);
  const networkControls = useScannerNetworkControls();
  const summary = useGetScannerSummary({
    query: {
      queryKey: getGetScannerSummaryQueryKey(),
      refetchInterval: STATUS_REFRESH_MS,
    },
  });
  const networks = useGetScannerNetworks({
    query: {
      queryKey: getGetScannerNetworksQueryKey(),
      refetchInterval: STATUS_REFRESH_MS,
    },
  });
  const across = useGetScannerAcrossStatus({
    query: {
      queryKey: getGetScannerAcrossStatusQueryKey(),
      refetchInterval: STATUS_REFRESH_MS,
    },
  });
  const acrossOpportunities = useGetScannerAcrossOpportunities({
    query: {
      queryKey: getGetScannerAcrossOpportunitiesQueryKey(),
      refetchInterval: OPPORTUNITY_REFRESH_MS,
    },
  });
  const tokens = useGetScannerTokens({
    query: {
      queryKey: getGetScannerTokensQueryKey(),
      refetchInterval: SLOW_DATA_REFRESH_MS,
    },
  });
  const [chain, setChain] = useState<GetScannerOpportunitiesChain>("all");
  const enabledChains = networkControls.data?.enabledChains ?? [];
  useEffect(() => {
    if (chain !== "all" && enabledChains.length && !enabledChains.includes(chain))
      setChain("all");
  }, [chain, enabledChains]);
  const opportunityParams = { chain, minProfitBps: 0, limit: 300 };
  const opportunities = useGetScannerOpportunities(opportunityParams, {
    query: {
      queryKey: getGetScannerOpportunitiesQueryKey(opportunityParams),
      refetchInterval: OPPORTUNITY_REFRESH_MS,
    },
  });
  const liquidationParams = { maxHealthFactor: 1.05, limit: 100 };
  const liquidations = useGetLiquidationOpportunities(liquidationParams, {
    query: {
      queryKey: getGetLiquidationOpportunitiesQueryKey(liquidationParams),
      refetchInterval: SLOW_DATA_REFRESH_MS,
    },
  });
  const health = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      refetchInterval: STATUS_REFRESH_MS,
    },
  });
  const client = useQueryClient();
  const refreshing =
    summary.isFetching ||
    networks.isFetching ||
    across.isFetching ||
    acrossOpportunities.isFetching ||
    tokens.isFetching ||
    opportunities.isFetching ||
    liquidations.isFetching;
  const refresh = () => {
    client.invalidateQueries({ queryKey: getGetScannerSummaryQueryKey() });
    client.invalidateQueries({ queryKey: getGetScannerNetworksQueryKey() });
    client.invalidateQueries({ queryKey: getGetScannerAcrossStatusQueryKey() });
    client.invalidateQueries({ queryKey: getGetScannerAcrossOpportunitiesQueryKey() });
    client.invalidateQueries({ queryKey: getGetScannerTokensQueryKey() });
    client.invalidateQueries({
      queryKey: getGetScannerOpportunitiesQueryKey(),
    });
    client.invalidateQueries({
      queryKey: getGetLiquidationOpportunitiesQueryKey(),
    });
    client.invalidateQueries({ queryKey: getHealthCheckQueryKey() });
  };

  return (
    <div className="relative flex min-h-dvh">
      <QuantumBackdrop />
      <Sidebar mobileOpen={mobileOpen} close={() => setMobileOpen(false)} />
      <div className="relative z-10 min-w-0 flex-1">
        <Topbar
          onMenu={() => setMobileOpen(true)}
          onRefresh={refresh}
          refreshing={refreshing}
        />
        <main className="mx-auto max-w-[1500px] px-4 pb-16 pt-8 sm:px-8 sm:pt-12">
          <Hero
            healthOk={health.data?.status === "ok"}
            healthError={health.isError}
          />
          <Summary loading={summary.isLoading} data={summary.data} />
          <OpportunityFunnel data={summary.data} />
          <ActivityChart
            opportunities={summary.data?.activeOpportunities}
            profit24h={summary.data?.estimatedNetProfit24h}
          />
          <NetworkStrip
            data={networks.data}
            loading={networks.isLoading}
            error={networks.isError}
            retry={() => networks.refetch()}
          />
          <NetworkControls
            controls={networkControls.data}
            loading={networkControls.loading}
            saving={networkControls.saving}
            error={networkControls.error}
            onChange={async (nextEnabledChains) => {
              if (await networkControls.setEnabledChains(nextEnabledChains)) {
                void summary.refetch();
                void networks.refetch();
                void tokens.refetch();
                void opportunities.refetch();
              }
            }}
          />
          <AcrossMission data={across.data} snapshot={acrossOpportunities.data} loading={across.isLoading || acrossOpportunities.isLoading} error={across.isError || acrossOpportunities.isError} retry={() => { void across.refetch(); void acrossOpportunities.refetch(); }} />
          <Opportunities
            data={opportunities.data}
            loading={opportunities.isLoading}
            error={opportunities.isError}
            retry={() => opportunities.refetch()}
            onSelect={setSelected}
            chain={chain}
            onChainChange={setChain}
            enabledChains={enabledChains}
          />
          <Liquidations
            data={liquidations.data}
            loading={liquidations.isLoading}
            error={liquidations.isError}
            retry={() => liquidations.refetch()}
            onSelect={setSelectedLiquidation}
          />
          <TokenUniverse
            data={tokens.data}
            loading={tokens.isLoading}
            error={tokens.isError}
            retry={() => tokens.refetch()}
          />
          <footer className="flex flex-col gap-2 border-t border-border pt-5 font-mono-tight text-[9px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              Arbitrage Scanner <b className="text-primary">·</b> Real-time
              market intelligence
            </span>
            <span className="flex items-center gap-2">
              Data refreshes automatically <span className="dot-live" />
            </span>
          </footer>
        </main>
      </div>
      <DetailDrawer selected={selected} close={() => setSelected(null)} />
      <LiquidationDetailDrawer
        selected={selectedLiquidation}
        close={() => setSelectedLiquidation(null)}
      />
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Cockpit} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
        <Router />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
