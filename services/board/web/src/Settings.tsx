import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { TelegramSignIn } from "./components";
import { ConnectionPanel } from "./Connections";
import type { Connection, Connections, ConnectionState, SignInSession } from "./types";
import { WhatsAppPanel } from "./WhatsApp";

const STATE_LABEL: Record<ConnectionState, string> = { ok: "Connected", attention: "Needs attention", off: "Not connected", unset: "Not set up", unknown: "Unknown" };

function ago(iso: string | undefined | null): string {
  if (!iso) return "";
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : new Date(iso).toLocaleDateString();
}

/**
 * Settings: every connection Pennyworth has (D-36…D-64), with its state and account, and how to
 * connect or reconnect it. Board sign-ins happen right here; sign-ins made on the laptop show the
 * command to run, and the runner's last check.
 */
export function SettingsPage({ canConnect }: { canConnect: boolean }) {
  const [data, setData] = useState<Connections>();
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const live = useRef(true);
  const load = useCallback(async () => {
    try {
      const d = await api.connections();
      if (live.current) (setData(d), setError(""));
      return d;
    } catch (err) {
      if (live.current) setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => ((live.current = false), clearInterval(t));
  }, [load]);

  async function checkNow() {
    setChecking(true);
    try {
      const before = laptopCheckedAt(await api.checkConnections());
      // The runner picks the request up within 30 seconds and checks in about one; wait for its answer.
      for (let i = 0; i < 24 && live.current; i++) {
        await new Promise((r) => setTimeout(r, 5_000));
        const d = await load();
        if (d && laptopCheckedAt(d) !== before) break;
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (live.current) setChecking(false);
    }
  }

  const list = data?.connections ?? [];
  const count = (s: ConnectionState) => list.filter((c) => c.state === s).length;
  const laptopAt = data && laptopCheckedAt(data);
  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <header className="settings-page-heading">
        <div>
          <h1 id="settings-title">Settings</h1>
          <p>Your connections: who each is signed in as, whether it works, and how to connect more.</p>
        </div>
        <div className="settings-actions">
          <button className="btn" onClick={() => void checkNow()} disabled={checking || !data}>
            {checking ? "Checking…" : "Check now"}
          </button>
          <a className="btn" href="#/">
            Back to board
          </a>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading connections…</p>}
      {data && (
        <p className="settings-summary" role="status">
          <span>
            <b>{count("ok")}</b> connected
          </span>
          {count("attention") > 0 && (
            <span>
              <b>{count("attention")}</b> {count("attention") === 1 ? "needs" : "need"} attention
            </span>
          )}
          {count("off") > 0 && (
            <span>
              <b>{count("off")}</b> not connected
            </span>
          )}
          {count("unset") > 0 && (
            <span>
              <b>{count("unset")}</b> not set up
            </span>
          )}
        </p>
      )}
      {data && (
        <>
          <h2 className="conn-group">Signed in on the board</h2>
          <p className="conn-group-note">Connect and reconnect these here. Most sign-ins come back to the board on this laptop, so start them there.</p>
          <div className="conn-list">
            {list
              .filter((c) => c.group === "board")
              .map((c) => (
                <ConnectionCard key={c.id} c={c} canConnect={canConnect} bannerHidden={Boolean(data.hiddenBanners?.[c.id])} onChange={() => void load()} />
              ))}
          </div>
          <h2 className="conn-group">Signed in on this laptop</h2>
          <p className="conn-group-note">
            These sign-ins live in a terminal on the laptop. The runner checks them every 15 minutes
            {laptopAt ? ` (last ${ago(laptopAt)})` : data.runnerSeenAt ? "" : "; it hasn't reported since the board started"}. Run the command shown to connect, then Check now.
          </p>
          <div className="conn-list">
            {list
              .filter((c) => c.group === "laptop")
              .map((c) => (
                <ConnectionCard key={c.id} c={c} canConnect={canConnect} bannerHidden={Boolean(data.hiddenBanners?.[c.id])} onChange={() => void load()} />
              ))}
          </div>
        </>
      )}
    </main>
  );
}

const laptopCheckedAt = (d: Connections) => d.connections.find((c) => c.group === "laptop" && c.checkedAt)?.checkedAt;

function ConnectionCard({ c, canConnect, bannerHidden, onChange }: { c: Connection; canConnect: boolean; bannerHidden: boolean; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const a = c.action;
  const verb = c.state === "ok" || c.state === "attention" ? "Reconnect" : "Connect";
  let side: React.ReactNode = null;
  if (a.kind === "connect") {
    side = canConnect ? (
      <a className={`btn${c.state === "attention" || c.state === "off" ? " primary" : ""}`} href={a.href}>
        {verb}
      </a>
    ) : (
      <span className="conn-note">Connect from the laptop</span>
    );
  } else {
    const label = a.kind === "signin" ? verb : a.kind === "panel" ? (c.state === "ok" ? (c.id === "google" ? "Manage" : verb) : verb) : a.kind === "setup" || c.state === "unset" ? "How to set up" : c.state === "ok" || c.state === "attention" ? "How to reconnect" : "How to connect";
    side = (
      <button className={`btn${!open && (c.state === "attention" || c.state === "off") ? " primary" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Close" : label}
      </button>
    );
  }
  const accountsAttention = c.accounts.some((x) => x.state === "attention");
  return (
    <section className="conn" aria-labelledby={`conn-${c.id}`}>
      <div className="conn-head">
        <span className={`conn-dot ${c.state}`} aria-hidden="true" />
        <div className="conn-main">
          <div className="conn-title">
            <h3 id={`conn-${c.id}`}>{c.name}</h3>
            <span className={`conn-state ${c.state}`}>
              {STATE_LABEL[c.state]}
              {c.state !== "ok" && c.since ? ` since ${ago(c.since)}` : ""}
            </span>
          </div>
          {c.accounts.length > 0 && (
            <ul className="conn-accounts">
              {c.accounts.map((x) => (
                <li key={x.label} className={x.state === "attention" ? "attention" : undefined}>
                  <span>{x.label}</span>
                  {x.primary && <span className="muted">· primary</span>}
                  {(x.state !== "ok" || accountsAttention) && x.state !== c.state && <span>· {STATE_LABEL[x.state].toLowerCase()}</span>}
                  {x.detail && x.state !== "ok" && <span className="muted">· {x.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {bannerHidden && c.state !== "ok" && (
            <p className="conn-note">
              Its banner on the board is hidden until this changes.{" "}
              <button className="link-btn" onClick={() => void api.showBanner(c.id).then(onChange, () => undefined)}>
                Show it again
              </button>
            </p>
          )}
          {c.detail && c.state !== "ok" && <p className={`conn-detail${c.state === "unset" || c.state === "off" || c.state === "unknown" ? " muted" : ""}`}>{c.detail}</p>}
          <p className="conn-purpose">
            {c.purpose} For {c.usedBy}.
          </p>
        </div>
        <div className="conn-side">{side}</div>
      </div>
      {open && (
        <div className="conn-body">
          {a.kind === "panel" && a.panel === "google" && <ConnectionPanel provider="google" bare onChange={onChange} />}
          {a.kind === "panel" && a.panel === "slack" && <ConnectionPanel provider="slack" bare onChange={onChange} />}
          {a.kind === "panel" && a.panel === "whatsapp" && <WhatsAppPanel />}
          {a.kind === "panel" &&
            a.panel === "telegram" &&
            (canConnect ? (
              <TelegramSignIn className="conn-telegram" fieldClassName="connection-field" onDone={() => (setOpen(false), onChange())} onCancel={() => setOpen(false)} />
            ) : (
              <p className="conn-note">Sign in from the board on your laptop.</p>
            ))}
          {a.kind === "signin" && <SignInFlow provider={a.provider} name={c.name} command={a.command} note={a.note} onDone={onChange} onClose={() => setOpen(false)} />}
          {a.kind === "command" && <Command command={a.command} note={a.note} />}
          {a.kind === "setup" && <p className="conn-note">{a.note}</p>}
        </div>
      )}
    </section>
  );
}

function Command({ command, note }: { command: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <div className="conn-cmd">
        <code>{command}</code>
        <button
          className="btn"
          onClick={() =>
            void navigator.clipboard?.writeText(command).then(
              () => (setCopied(true), setTimeout(() => setCopied(false), 1500)),
              () => undefined,
            )
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="conn-note">{note ?? "Run it in a terminal in the Pennyworth folder on the laptop."}</p>
    </>
  );
}

/**
 * A sign-in the runner makes on the laptop (D-66): it starts the tool's own login, and this shows
 * what to do: open the link, enter the code there, or paste back what the page shows.
 */
function SignInFlow({ provider, name, command, note, onDone, onClose }: { provider: string; name: string; command: string; note?: string; onDone: () => void; onClose: () => void }) {
  const [session, setSession] = useState<SignInSession | null>(null);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const live = useRef(true);
  const finished = (s: SignInSession | null) => !s || s.status === "done" || s.status === "failed" || s.status === "cancelled";

  async function start() {
    setError("");
    setSession(null);
    try {
      setSession((await api.startSignIn(provider)).session);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  useEffect(() => {
    live.current = true;
    void start();
    return () => {
      live.current = false;
    };
  }, [provider]);
  // Follow the runner's progress while the sign-in is open.
  useEffect(() => {
    if (finished(session)) return;
    const t = setInterval(async () => {
      try {
        const r = await api.signIn(provider);
        if (!live.current) return;
        setSession(r.session);
        if (r.session?.status === "done") onDone();
      } catch {}
    }, 1_500);
    return () => clearInterval(t);
  }, [provider, session?.status]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    setBusy(true);
    try {
      setSession((await api.answerSignIn(provider, answer.trim())).session);
      setAnswer("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    await api.cancelSignIn(provider).catch(() => undefined);
    onClose();
  }

  const s = session;
  return (
    <div className="signin">
      {error && <p role="alert">{error}</p>}
      {!s && !error && <p className="conn-note" role="status">Starting…</p>}
      {s && s.status !== "done" && s.status !== "failed" && s.status !== "cancelled" && (
        <>
          {s.url && (
            <p className="signin-step">
              <span className="signin-n">1</span>
              <a className="btn primary" href={s.url} target="_blank" rel="noreferrer">
                Open {name} sign-in
              </a>
            </p>
          )}
          {s.code && (
            <p className="signin-step">
              <span className="signin-n">2</span>
              <span>
                Enter this code there: <CopyCode code={s.code} />
              </span>
            </p>
          )}
          {s.prompt && (
            <form className="signin-step" onSubmit={submit}>
              <span className="signin-n">{s.url ? 2 : 1}</span>
              <label className="connection-field signin-field">
                <span>{s.prompt.label}</span>
                <input autoFocus type={s.prompt.secret ? "password" : "text"} autoComplete="off" spellCheck={false} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={busy} />
              </label>
              <button className="btn primary" type="submit" disabled={busy || !answer.trim()}>
                {busy ? "…" : "Continue"}
              </button>
            </form>
          )}
          <p className="conn-note" role="status">
            {s.message ?? (s.code && !s.prompt ? "Waiting for you to approve it there. This page updates by itself." : s.url && !s.prompt ? "Waiting for the sign-in to finish…" : "")}
          </p>
          <p>
            <button className="btn" onClick={() => void cancel()}>
              Cancel
            </button>
          </p>
        </>
      )}
      {s?.status === "done" && (
        <p className="signin-ok" role="status">
          {s.message ?? "Connected."}
        </p>
      )}
      {(s?.status === "failed" || s?.status === "cancelled") && (
        <>
          <p role="alert">{s.message}</p>
          <p>
            <button className="btn" onClick={() => void start()}>
              Try again
            </button>
          </p>
        </>
      )}
      <p className="conn-note">
        <button className="link-btn" onClick={() => setTerminal(!terminal)} aria-expanded={terminal}>
          {terminal ? "Hide" : "Or sign in from a terminal"}
        </button>
      </p>
      {terminal && <Command command={command} note={note} />}
    </div>
  );
}

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <code className="signin-code">{code}</code>{" "}
      <button className="btn" onClick={() => void navigator.clipboard?.writeText(code).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)), () => undefined)}>
        {copied ? "Copied" : "Copy"}
      </button>
    </>
  );
}
