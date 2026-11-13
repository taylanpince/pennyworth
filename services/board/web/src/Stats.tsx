import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { PairRequired, statsApi } from "./api";
import type { Stats, StatsDelta, StatsRange } from "./types";
import { ago } from "./util";

// The Stats view (D-62): what the agents cost and do, over 7, 30 or 90 days next to the period before.
// Charts are hand-drawn SVG (the board's CSP allows only its own assets). Colours are categorical slots
// (styles.css --series-N), fixed per entity, never by rank; every chart has its table view.

const RANGE_KEY = "pennyworth.stats.range";
const RANGES: StatsRange[] = ["7d", "30d", "90d"];
const savedRange = (): StatsRange => {
  try {
    const r = localStorage.getItem(RANGE_KEY);
    return r === "7d" || r === "90d" ? r : "30d";
  } catch {
    return "30d";
  }
};

const slot = (n: number) => `var(--series-${n})`;
const OTHER = "var(--series-other)";

/** Token groups (statsmath TOKEN_GROUPS): a fixed colour each. */
const GROUP_COLORS: Record<string, string> = { assistant: slot(1), writer: slot(2), engineers: slot(3), slack: slot(4), telegram: slot(5), meetings: slot(6), brief: slot(7), other: OTHER };
/** Task sources: the busy ones get a fixed colour, the rest fold into Other. */
const SOURCE_COLORS: Record<string, string> = { meeting: slot(1), slack: slot(2), "slack-pin": slot(3), telegram: slot(4), gmail: slot(5), you: slot(6), brief: slot(7) };
const SOURCE_NAMES: Record<string, string> = { meeting: "Meetings", slack: "Slack asks", "slack-pin": "Slack pins", telegram: "Telegram", gmail: "Email", you: "You", brief: "Brief", recurring: "Recurring", github: "GitHub", primer: "Primer", crew: "Crew", agent: "Agents", other: "Other" };
const sourceName = (s: string) => SOURCE_NAMES[s] ?? s;

// ---------------------------------------------------------------- formats

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}
const exact = (n: number) => Math.round(n).toLocaleString("en-US");
const money = (n: number) => (n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const hours = (h: number | null) => (h === null ? "—" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)}h` : `${(h / 24).toFixed(1)}d`);
const minutes = (m: number | null) => (m === null ? "—" : m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`);
const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

// ------------------------------------------------------------------- view

export function StatsView({ onPairing }: { onPairing: () => void }) {
  const [range, setRangeState] = useState<StatsRange>(savedRange);
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const setRange = (r: StatsRange) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {}
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await statsApi.get(range));
      setError("");
    } catch (e) {
      if (e instanceof PairRequired) onPairing();
      else setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range, onPairing]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => document.visibilityState === "visible" && void load(), 5 * 60_000);
    return () => clearInterval(poll);
  }, [load]);

  const prevLabel = `vs previous ${range === "7d" ? "7" : range === "30d" ? "30" : "90"} days`;

  return (
    <main className="agents stats">
      <div className="stats-filters">
        <div className="range-seg" role="radiogroup" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r} role="radio" aria-checked={r === range} className={r === range ? "on" : ""} onClick={() => setRange(r)}>
              {r === "7d" ? "7 days" : r === "30d" ? "30 days" : "90 days"}
            </button>
          ))}
        </div>
        {data && (
          <span className="hint">
            {shortDay(data.period.from)} – {shortDay(data.period.to)}
            {data.coverage.runsSyncedAt && ` · runs synced ${ago(data.coverage.runsSyncedAt)} ago`}
          </span>
        )}
      </div>
      {error && <div className="alert">Couldn't load stats: {error}</div>}
      {!data ? (
        !error && <span className="spinner" />
      ) : (
        <div className={`stats-body${loading ? " stale" : ""}`}>
          {!data.coverage.runsSyncedAt && <p className="agents-note">Paperclip's runs are still being copied (the first sync starts a minute after the board does). Numbers fill in as it goes.</p>}
          <Headline s={data} prevLabel={prevLabel} />
          <TokenSection s={data} />
          <ModelSection s={data} />
          <RolesSection s={data} />
          <TopTasks s={data} />
          <FlowSection s={data} />
          <ReliabilitySection s={data} />
          <ToolsSection s={data} />
          <MemorySection s={data} prevLabel={prevLabel} />
        </div>
      )}
    </main>
  );
}

function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="stats-section">
      <header className="agents-head">
        <h2>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
      </header>
      {children}
    </section>
  );
}

const noJobs = <p className="empty">The runner hasn't reported usage yet: Engineer jobs show here once it does.</p>;

// ------------------------------------------------------------- headline

function Delta({ d, prevLabel, format = compact }: { d: StatsDelta; prevLabel: string; format?: (n: number) => string }) {
  if (!d.prev && !d.cur) return <span className="delta">—</span>;
  if (!d.prev) return <span className="delta">new · none before</span>;
  const change = (d.cur - d.prev) / d.prev;
  const arrow = change > 0.005 ? "↑" : change < -0.005 ? "↓" : "→";
  return (
    <span className="delta" title={`${format(d.prev)} ${prevLabel}`}>
      {arrow} {Math.abs(Math.round(change * 100))}% {prevLabel}
    </span>
  );
}

function Tile({ label, value, title, children }: { label: string; value: string; title?: string; children?: ReactNode }) {
  return (
    <div className="stat-tile" title={title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {children}
    </div>
  );
}

function Headline({ s, prevLabel }: { s: Stats; prevLabel: string }) {
  const h = s.headline;
  return (
    <div className="stat-tiles">
      <Tile label="Tokens" value={compact(h.tokens.cur)} title={`${exact(h.tokens.cur)} tokens: every agent run and Engineer job`}>
        <Delta d={h.tokens} prevLabel={prevLabel} />
        <span className="stat-note">{pct(h.cachedShare.cur)} of input from cache</span>
      </Tile>
      <Tile label="List-price equivalent" value={s.coverage.hasJobs ? money(h.costUsd.cur) : "—"} title="What Engineer jobs would cost at API list prices. You pay subscriptions; Codex and Paperclip runs aren't priced.">
        {s.coverage.hasJobs ? <Delta d={h.costUsd} prevLabel={prevLabel} format={money} /> : <span className="delta">no runner usage yet</span>}
        <span className="stat-note">Engineer jobs at API prices; you pay subscriptions{h.unpricedJobs ? ` · ${h.unpricedJobs} unpriced` : ""}</span>
      </Tile>
      <Tile label="Engineer jobs" value={exact(h.jobs.cur)}>
        <Delta d={h.jobs} prevLabel={prevLabel} />
        <span className="stat-note">{exact(h.runs.cur)} Paperclip agent runs</span>
      </Tile>
      <Tile label="Tasks created" value={exact(h.tasksCreated.cur)}>
        <Delta d={h.tasksCreated} prevLabel={prevLabel} />
      </Tile>
      <Tile label="Tasks closed" value={exact(h.tasksClosed.cur)}>
        <Delta d={h.tasksClosed} prevLabel={prevLabel} />
      </Tile>
      <Tile label="Proposals waiting" value={exact(h.proposalsWaiting)}>
        <span className="delta">memories to review</span>
      </Tile>
    </div>
  );
}

// ---------------------------------------------------------------- charts

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(max: number): { top: number; ticks: number[] } {
  if (max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

/** A column with a 4px rounded data end and a square foot. */
function topRounded(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export interface ColumnSeries {
  key: string;
  name: string;
  color: string;
  values: number[];
}

/**
 * Stacked columns, one per bucket, with a 2px surface gap between segments; optional line on the same
 * axis (same unit only). Hover or focus a column for every series at that bucket.
 */
function StackedColumns({ buckets, series, line, format, label, height = 200, max: fixedMax }: { buckets: string[]; series: ColumnSeries[]; line?: { name: string; values: number[] }; format: (n: number) => string; label: (b: string) => string; height?: number; max?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const left = 44;
  const bottom = 22;
  const top = 8;
  const plotW = Math.max(0, width - left - 4);
  const plotH = height - top - bottom;
  const totals = buckets.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const { top: yMax, ticks } = niceMax(fixedMax ?? Math.max(...totals, ...(line?.values ?? [0])));
  const band = buckets.length ? plotW / buckets.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const y = (v: number) => top + plotH - (v / yMax) * plotH;
  const every = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 64))));
  const tip = hover === null ? null : { i: hover, x: left + band * hover + band / 2 };
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(", ")} onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - 4} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
              <text x={left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                {format(t)}
              </text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x = left + band * i + (band - barW) / 2;
            let acc = 0;
            const segs = series
              .map((s) => ({ s, v: s.values[i] ?? 0 }))
              .filter((x) => x.v > 0)
              .map(({ s, v }) => {
                const y0 = y(acc);
                acc += v;
                return { s, y1: y(acc), y0 };
              });
            return (
              <g key={b} className={hover !== null && hover !== i ? "dim" : undefined}>
                {segs.map(({ s, y0, y1 }, k) => {
                  const h = Math.max(0, y0 - y1 - (k > 0 ? 2 : 0));
                  if (h <= 0) return null;
                  return k === segs.length - 1 ? <path key={s.key} d={topRounded(x, y1, barW, h)} fill={s.color} /> : <rect key={s.key} x={x} y={y1} width={barW} height={h} fill={s.color} />;
                })}
                {i % every === 0 && (
                  <text x={x + barW / 2} y={height - 6} textAnchor="middle" className="tick">
                    {label(b)}
                  </text>
                )}
              </g>
            );
          })}
          {line && (
            <>
              <polyline className="chart-line" points={line.values.map((v, i) => `${left + band * i + band / 2},${y(v)}`).join(" ")} />
              {line.values.map((v, i) => (
                <circle key={i} className="chart-dot" cx={left + band * i + band / 2} cy={y(v)} r={4} />
              ))}
            </>
          )}
          {tip && <line className="crosshair" x1={tip.x} x2={tip.x} y1={top} y2={top + plotH} />}
          {buckets.map((b, i) => (
            <rect key={b} className="hit" x={left + band * i} y={top} width={band} height={plotH} tabIndex={0} aria-label={`${label(b)}: ${format(totals[i] ?? 0)}`} onPointerEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} />
          ))}
        </svg>
      )}
      {tip && (
        <div className={`chart-tip${tip.x > width / 2 ? " left" : ""}`} style={{ left: tip.x }}>
          <div className="tip-head">{label(buckets[tip.i]!)}</div>
          {[...series].reverse().map((s) => (
            <div key={s.key} className="tip-row">
              <i style={{ background: s.color }} />
              <b>{format(s.values[tip.i] ?? 0)}</b>
              <span>{s.name}</span>
            </div>
          ))}
          {line && (
            <div className="tip-row">
              <i className="line-key" />
              <b>{format(line.values[tip.i] ?? 0)}</b>
              <span>{line.name}</span>
            </div>
          )}
          {series.length > 1 && (
            <div className="tip-row total">
              <b>{format(totals[tip.i] ?? 0)}</b>
              <span>Total</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Legend({ items, line }: { items: { name: string; color: string }[]; line?: string }) {
  return (
    <div className="legend">
      {items.map((x) => (
        <span key={x.name}>
          <i style={{ background: x.color }} />
          {x.name}
        </span>
      ))}
      {line && (
        <span>
          <i className="line-key" />
          {line}
        </span>
      )}
    </div>
  );
}

/** Every chart's numbers as a table (tooltips never gate a value). */
function TableView({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="table-view">
      <summary>Table</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, k) => (
                  <td key={k}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** A one-colour horizontal bar per row: value at the tip, the label left. */
function Bars({ rows, format = exact, color = slot(1) }: { rows: { label: ReactNode; value: number; title?: string; key: string }[]; format?: (n: number) => string; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="hbars">
      {rows.map((r) => (
        <div key={r.key} className="hbar" title={r.title ?? `${format(r.value)}`}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
          </span>
          <span className="hbar-value">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** A small weekly trend line (Crew tiles): the current week marked. */
export function Sparkline({ values, title, width = 120, height = 28 }: { values: number[]; title: string; width?: number; height?: number }) {
  if (!values.length || values.every((v) => !v)) return null;
  const max = Math.max(...values);
  const x = (i: number) => 3 + (i / Math.max(1, values.length - 1)) * (width - 6);
  const y = (v: number) => height - 3 - (v / max) * (height - 6);
  const last = values.length - 1;
  return (
    <svg className="sparkline" width={width} height={height} role="img" aria-label={title}>
      <title>{title}</title>
      <polyline points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
      <circle cx={x(last)} cy={y(values[last]!)} r={3} />
    </svg>
  );
}

const Portrait = ({ avatar, name }: { avatar: string | null; name: string }) =>
  avatar ? <img className="avatar portrait" src={`/crew/${avatar}.svg`} alt="" width={28} height={28} draggable={false} /> : <span className="avatar avatar-assistant stats-initial">{name.slice(0, 1)}</span>;

// -------------------------------------------------------------- sections

function TokenSection({ s }: { s: Stats }) {
  const t = s.tokensDaily;
  const [split, setSplit] = useState(false);
  const label = (d: string) => shortDay(d);
  const byGroup: ColumnSeries[] = t.groups.map((g) => ({ key: g.key, name: g.name, color: GROUP_COLORS[g.key] ?? OTHER, values: g.uncached.map((u, i) => u + g.cached[i]! + g.output[i]!) }));
  const sum = (k: "uncached" | "cached" | "output") => t.days.map((_, i) => t.groups.reduce((n, g) => n + g[k][i]!, 0));
  const byKind: ColumnSeries[] = [
    { key: "cached", name: "Cached input", color: slot(1), values: sum("cached") },
    { key: "uncached", name: "Uncached input", color: slot(2), values: sum("uncached") },
    { key: "output", name: "Output", color: slot(3), values: sum("output") },
  ];
  const series = split ? byKind : byGroup;
  return (
    <Section title="Token usage" hint="Per day; Engineers are Ada, Linus, Whit and Grace's jobs">
      <div className="chart-head">
        <Legend items={series.map((x) => ({ name: x.name, color: x.color }))} />
        <div className="range-seg small">
          <button className={!split ? "on" : ""} onClick={() => setSplit(false)}>
            By agent
          </button>
          <button className={split ? "on" : ""} onClick={() => setSplit(true)}>
            Cached vs uncached
          </button>
        </div>
      </div>
      <StackedColumns buckets={t.days} series={series} format={compact} label={label} />
      <TableView
        head={["Agent", "Runs", "Jobs", "Uncached input", "Cached input", "Output", "Total"]}
        rows={t.agents.map((a) => [a.name, a.runs, a.jobs, exact(a.uncached), exact(a.cached), exact(a.output), exact(a.total)])}
      />
    </Section>
  );
}

function ModelSection({ s }: { s: Stats }) {
  const m = s.modelPreference;
  if (!s.coverage.hasJobs || !m.executors.length)
    return (
      <Section title="Model preference" hint="Engine and model per role">
        {noJobs}
      </Section>
    );
  // Colour by executor name (alphabetical), so a range change doesn't repaint the ones that stay.
  const named = [...m.executors].sort();
  const colorOf = (k: string) => (named.indexOf(k) < 7 ? slot(named.indexOf(k) + 1) : OTHER);
  const series: ColumnSeries[] = named.map((k) => ({
    key: k,
    name: k,
    color: colorOf(k),
    values: m.shares.map((b) => {
      const total = Object.values(b.counts).reduce((a, x) => a + x, 0);
      return total ? ((b.counts[k] ?? 0) / total) * 100 : 0;
    }),
  }));
  return (
    <Section title="Model preference" hint={`Share of Engineer jobs per ${s.granularity}`}>
      <Legend items={series.map((x) => ({ name: x.name, color: x.color }))} />
      <StackedColumns buckets={m.buckets} series={series} format={(n) => `${Math.round(n)}%`} label={(b) => (s.granularity === "week" ? `wk ${shortDay(b)}` : shortDay(b))} max={100} height={170} />
      <div className="role-rows">
        {m.roles
          .filter((r) => r.jobs)
          .map((r) => (
            <div key={r.agentId ?? "unknown"} className="role-row">
              <Portrait avatar={r.avatar} name={r.name} />
              <div className="role-main">
                <div>
                  <b>{r.name}</b> <span className="muted small">default {r.defaultExecutor ?? "—"}</span>
                </div>
                <div className="share-bar" aria-hidden="true">
                  {r.executors.map((x) => (
                    <span key={x.key} style={{ flexGrow: x.jobs, background: colorOf(x.key) }} title={`${x.key}: ${x.jobs} jobs`} />
                  ))}
                </div>
                <div className="muted small">
                  {r.jobs} jobs on {r.tasks} tasks · {r.nonDefaultTasks ? `${r.nonDefaultTasks} task${r.nonDefaultTasks === 1 ? "" : "s"} (${r.nonDefaultJobs} jobs) picked another engine or model` : "all on the role's default"}
                </div>
              </div>
            </div>
          ))}
      </div>
      <TableView head={["Role", "Engine · model", "Jobs"]} rows={m.roles.flatMap((r) => r.executors.map((x) => [r.name, x.key, x.jobs]))} />
    </Section>
  );
}

function RolesSection({ s }: { s: Stats }) {
  return (
    <Section title="The crew" hint="$ is the list-price equivalent of runner jobs">
      <div className="role-cards">
        {s.roles.map((r) => (
          <div key={r.agentId} className="role-card">
            <header>
              <Portrait avatar={r.avatar} name={r.name} />
              <b>{r.name}</b>
              <span className="muted small">{r.kind === "runner" ? "runner jobs" : "Paperclip runs"}</span>
            </header>
            {r.jobs === 0 ? (
              <p className="empty">{r.kind === "runner" && !s.coverage.hasJobs ? "No usage reported yet." : "Nothing in this range."}</p>
            ) : (
              <dl>
                <dt>Tasks</dt>
                <dd>{r.tasks}</dd>
                <dt>{r.kind === "runner" ? "Jobs" : "Runs"}</dt>
                <dd>
                  {r.jobs}
                  {r.jobsPerTask !== null && <span className="muted"> · {r.jobsPerTask}/task</span>}
                </dd>
                <dt>Median time</dt>
                <dd>{minutes(r.medianMinutes)}</dd>
                <dt>Tokens</dt>
                <dd>{compact(r.tokens)}</dd>
                {r.costUsd === null && r.jobs > 0 && (
                  <>
                    <dt>List price</dt>
                    <dd className="muted">unpriced (Codex)</dd>
                  </>
                )}
                {r.costUsd !== null && (
                  <>
                    <dt>List price</dt>
                    <dd>
                      {money(r.costUsd)}
                      {r.costPerTask !== null && <span className="muted"> · {money(r.costPerTask)}/task</span>}
                    </dd>
                  </>
                )}
                {r.maxContext !== null && (
                  <>
                    <dt>Context</dt>
                    <dd>
                      {compact(r.medianContext ?? 0)} median · {compact(r.maxContext)} max
                    </dd>
                  </>
                )}
                {r.restarted !== null && (
                  <>
                    <dt>Restarts · retries</dt>
                    <dd>
                      {r.restarted} · {r.retries}
                    </dd>
                  </>
                )}
              </dl>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function TopTasks({ s }: { s: Stats }) {
  return (
    <Section title="Most expensive tasks" hint="By list-price equivalent">
      {!s.coverage.hasJobs ? (
        noJobs
      ) : !s.topTasks.length ? (
        <p className="empty">No priced Engineer jobs in this range.</p>
      ) : (
        <div className="table-wrap">
          <table className="stats-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Who</th>
                <th className="num">List price</th>
                <th className="num">Jobs</th>
                <th className="num">Peak context</th>
              </tr>
            </thead>
            <tbody>
              {s.topTasks.map((t) => (
                <tr key={t.identifier}>
                  <td className="task-cell">
                    <a href={t.parent ? `#/t/${t.parent}/${t.identifier}` : `#/t/${t.identifier}`}>{t.parent ?? t.identifier}</a> <span className="title">{t.title ?? ""}</span>
                  </td>
                  <td>{t.agent ?? "—"}</td>
                  <td className="num">{money(t.costUsd)}</td>
                  <td className="num">{t.jobs}</td>
                  <td className="num">{compact(t.peakContext)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function FlowSection({ s }: { s: Stats }) {
  const f = s.taskFlow;
  const label = (b: string) => (s.granularity === "week" ? `wk ${shortDay(b)}` : shortDay(b));
  const named = Object.keys(SOURCE_COLORS).filter((k) => f.sources.includes(k));
  const others = f.sources.filter((k) => !SOURCE_COLORS[k]);
  const series: ColumnSeries[] = [
    ...named.map((k) => ({ key: k, name: sourceName(k), color: SOURCE_COLORS[k]!, values: f.created.map((b) => b.bySource[k] ?? 0) })),
    ...(others.length ? [{ key: "other", name: `Other (${others.map(sourceName).join(", ")})`, color: OTHER, values: f.created.map((b) => others.reduce((n, k) => n + (b.bySource[k] ?? 0), 0)) }] : []),
  ];
  return (
    <Section title="Task flow" hint={`Your tasks per ${s.granularity} (crew parts left out)`}>
      <Legend items={series.map((x) => ({ name: x.name, color: x.color }))} line="Closed" />
      <StackedColumns buckets={f.buckets} series={series} line={{ name: "Closed", values: f.closed }} format={exact} label={label} />
      <TableView head={["", ...f.sources.map(sourceName), "Closed"]} rows={f.buckets.map((b, i) => [label(b), ...f.sources.map((k) => f.created[i]!.bySource[k] ?? 0), f.closed[i]!])} />
      <div className="stats-grid">
        <div>
          <h3>Time to done</h3>
          <div className="table-wrap">
            <table className="stats-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="num">Created</th>
                  <th className="num">Done</th>
                  <th className="num">Median</th>
                  <th className="num">90th %</th>
                </tr>
              </thead>
              <tbody>
                {f.timeToClose.map((t) => (
                  <tr key={t.source}>
                    <td>{sourceName(t.source)}</td>
                    <td className="num">{t.created}</td>
                    <td className="num">{t.done}</td>
                    <td className="num">{hours(t.medianHours)}</td>
                    <td className="num">{hours(t.p90Hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3>Scout yield</h3>
          <Bars rows={f.scoutYield.map((y) => ({ key: y.agentId, label: y.name, value: y.perHundredRuns ?? 0, title: `${y.tasks} tasks from ${y.runs} runs` }))} format={(n) => `${n.toFixed(n < 10 ? 1 : 0)}`} />
          <p className="muted small">Tasks per 100 runs: {f.scoutYield.map((y) => `${y.name} ${y.tasks}/${y.runs}`).join(" · ")}</p>
        </div>
      </div>
    </Section>
  );
}

function ReliabilitySection({ s }: { s: Stats }) {
  const r = s.reliability;
  return (
    <Section title="Reliability" hint={`${r.runs.failed} failed and ${r.runs.cancelled} cancelled of ${exact(r.runs.total)} agent runs; Paperclip retried ${r.runs.retried}`}>
      <div className="stats-grid">
        <div>
          <h3>Failure rate by agent</h3>
          <Bars rows={r.agents.filter((a) => a.runs).map((a) => ({ key: a.agentId, label: a.name, value: a.rate * 100, title: `${a.failed} failed, ${a.cancelled} cancelled of ${a.runs} runs${a.errors.length ? `: ${a.errors.map((e) => `${e.label} (${e.count})`).join(", ")}` : ""}` }))} format={(n) => `${n.toFixed(n < 10 ? 1 : 0)}%`} color={slot(8)} />
        </div>
        <div>
          <h3>Top causes</h3>
          {r.topErrors.length ? <Bars rows={r.topErrors.map((e) => ({ key: e.label, label: e.label, value: e.count }))} color={slot(8)} /> : <p className="empty">No failures in this range.</p>}
        </div>
      </div>
      <h3>Engineer jobs</h3>
      {!s.coverage.hasJobs ? (
        noJobs
      ) : (
        <p className="small">
          {r.runner.failed} of {r.runner.finished} finished jobs failed ({pct(r.runner.rate)}), {r.runner.cancelled} stopped; {r.runner.retries} were "try again" retries ({pct(r.runner.retryShare)} of jobs).{" "}
          <span className="muted">{Object.entries(r.runner.byStatus).map(([k, n]) => `${k} ${n}`).join(" · ")}</span>
        </p>
      )}
      <TableView head={["Agent", "Runs", "Failed", "Cancelled", "Rate", "Causes"]} rows={r.agents.map((a) => [a.name, a.runs, a.failed, a.cancelled, pct(a.rate), a.errors.map((e) => `${e.label} (${e.count})`).join(", ")])} />
    </Section>
  );
}

function ToolsSection({ s }: { s: Stats }) {
  const t = s.tools;
  const label = (b: string) => (s.granularity === "week" ? `wk ${shortDay(b)}` : shortDay(b));
  if (!s.coverage.hasJobs)
    return (
      <Section title="Tools" hint="MCP servers and built-in tools in Engineer jobs">
        {noJobs}
      </Section>
    );
  const named = t.mcp.map((m) => m.server).sort();
  const series: ColumnSeries[] = named.slice(0, 7).map((k, i) => ({ key: k, name: k, color: slot(i + 1), values: t.mcp.find((m) => m.server === k)!.counts }));
  if (named.length > 7) series.push({ key: "other", name: "Other", color: OTHER, values: t.buckets.map((_, i) => t.mcp.filter((m) => !named.slice(0, 7).includes(m.server)).reduce((n, m) => n + m.counts[i]!, 0)) });
  return (
    <Section title="Tools" hint={`MCP calls in Engineer jobs per ${s.granularity}`}>
      {t.mcp.length ? (
        <>
          <Legend items={series.map((x) => ({ name: x.name, color: x.color }))} />
          <StackedColumns buckets={t.buckets} series={series} format={exact} label={label} height={170} />
          <TableView head={["Server", "Calls", "Jobs using it"]} rows={t.mcp.map((m) => [m.server, m.total, m.jobs])} />
        </>
      ) : (
        <p className="empty">No MCP calls in this range.</p>
      )}
      <h3>Top built-in tools</h3>
      <Bars rows={t.builtin.map((b) => ({ key: b.tool, label: b.tool, value: b.count }))} />
    </Section>
  );
}

function MemorySection({ s, prevLabel }: { s: Stats; prevLabel: string }) {
  const m = s.memory;
  return (
    <Section title="Memory" hint="Corrections show up as proposals (D-61)">
      <div className="stat-tiles small">
        <Tile label="Proposed" value={exact(m.proposed.cur)}>
          <Delta d={m.proposed} prevLabel={prevLabel} />
        </Tile>
        <Tile label="Accepted" value={exact(m.accepted.cur)}>
          <Delta d={m.accepted} prevLabel={prevLabel} />
        </Tile>
        <Tile label="Rejected" value={exact(m.rejected.cur)}>
          <Delta d={m.rejected} prevLabel={prevLabel} />
        </Tile>
        <Tile label="Remembered on your word" value={exact(m.remembered.cur)}>
          <Delta d={m.remembered} prevLabel={prevLabel} />
        </Tile>
        <Tile label="Unused 30 days" value={exact(m.stale)}>
          <span className="delta">{m.waiting} waiting for you</span>
        </Tile>
      </div>
      <div className="budget-rows">
        {m.scopes.map((x) => (
          <div key={x.scope} className="budget-row" title={`${exact(x.used)} of ${exact(x.budget)} characters${x.omitted ? `, ${x.omitted} left out` : ""}`}>
            {x.scope === "global" ? <span className="avatar avatar-me stats-initial">∗</span> : <Portrait avatar={x.avatar} name={x.name} />}
            <span className="budget-name">{x.name}</span>
            <span className="muted small">
              {x.active} active{x.proposals ? ` · ${x.proposals} proposed` : ""}
            </span>
            <span className="meter">
              <span className={x.omitted ? "over" : ""} style={{ width: `${Math.min(100, (x.used / (x.budget || 1)) * 100)}%` }} />
            </span>
            <span className="small num">{x.budget ? pct(x.used / x.budget) : "—"}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}
