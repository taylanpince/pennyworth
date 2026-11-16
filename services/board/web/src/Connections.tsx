import { useEffect, useState } from "react";

type Status = { enabled?: boolean; configured?: boolean; connected?: boolean; error?: string; accounts?: { email: string; state: string; primary: boolean }[] };
export function ConnectionPanel({ provider }: { provider: "google" | "slack" }) {
  const name = provider === "google" ? "Google" : "Slack";
  const [status, setStatus] = useState<Status>();
  const [clientId, setClientId] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState("");
  const [callback, setCallback] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function request(path: string, body?: unknown) {
    const res = await fetch(`/api/connections/${provider}/${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-pennyworth-board": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Connection unavailable");
    return data;
  }
  useEffect(() => { let live = true; void request("status").then(s => { if (live) setStatus(s); }).catch(() => { if (live) setError("Connection status unavailable. Reload Settings to retry."); }); return () => { live = false; }; }, [provider]);
  async function configure(data: { client_id: string; client_secret?: string }) {
    setBusy(true); setError("");
    try { await request("configure", data); setClientId(""); setStatus(await request("status")); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function upload(file?: File) {
    if (!file) return;
    try {
      if (file.size > 16_384) throw new Error("Choose the Google OAuth Desktop client JSON download.");
      const json = JSON.parse(await file.text());
      if (!json.installed?.client_id || !json.installed?.client_secret) throw new Error("Choose a Desktop app OAuth client JSON download.");
      await configure({ client_id: json.installed.client_id, client_secret: json.installed.client_secret });
    } catch (err) { setError((err as Error).message); }
  }
  async function act(finish: boolean) {
    setBusy(true); setError(""); setDone(false);
    try {
      if (finish) {
        await request("finish", { callback }); setCallback(""); setConsent(""); setDone(true); setStatus(await request("status"));
      } else {
        const result = await request("start", provider === "google" ? { account: email } : {});
        setConsent(result.url); setCallback("");
      }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  const ready = status?.enabled && status.configured !== false;
  return <section className="settings-card">
    <h2>{name}</h2>
    <p>{provider === "google" ? "Connect read-only access to Gmail, Calendar and Drive. Email tasks follow your configured label rules." : "Connect your Slack workspace for mentions, replies and pinned action items."}</p>
    {!status && !error && <p role="status">Loading connection…</p>}
    {status && !status.enabled && <p>Board sign-in is not enabled on this server. Enable the connection service and its board authentication credential first.</p>}
    {status?.enabled && provider === "slack" && !status.configured && <p>Slack needs an OAuth client for your workspace. Enter its client ID below. Register the callback http://localhost:3118/callback.</p>}
    {provider === "slack" && status?.configured && <p>{status.connected ? "Connected · reconnect to renew access or change workspace." : "Not connected"}</p>}
    {provider === "google" && status?.accounts?.map(a => <p key={a.email}>{a.email} · {a.state}{a.primary ? " · primary" : ""}</p>)}
    {provider === "google" && status?.enabled && !status.accounts?.length && <p>No accounts connected. Use a Google OAuth Desktop client with the Gmail, Calendar and Drive APIs enabled.</p>}
    {status?.enabled && status.configured === false && <>
      {provider === "google" ? <label className="connection-field">Google Desktop client JSON<input type="file" accept="application/json,.json" disabled={busy} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} /></label> : <>
        <label className="connection-field">Slack OAuth client ID<input value={clientId} onChange={e => setClientId(e.target.value)} autoComplete="off" /></label>
        <button className="btn" disabled={busy || !clientId.trim()} onClick={() => void configure({ client_id: clientId.trim() })}>Save client ID</button>
      </>}
      <p>Credentials are saved on this server. Provider consent is the next step.</p>
    </>}
    {ready && <>
      {provider === "google" && <label className="connection-field">Google email<input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>}
      <button className="btn" disabled={busy || (provider === "google" && !email)} onClick={() => void act(false)}>{consent ? "Restart sign-in" : "Connect / reconnect"}</button>
      {consent && <div className="connection-flow">
        <p><a className="btn primary" href={consent} target="_blank" rel="noreferrer">Continue with {name}</a></p>
        <p>Approve access in the new tab. The final localhost page may fail to load on your laptop; copy its entire address and paste it below. Complete this within ten minutes using this same browser.</p>
        <label className="connection-field">Final callback URL<input type="text" value={callback} onChange={e => setCallback(e.target.value)} autoComplete="off" spellCheck={false} /></label>
        <button className="btn" disabled={busy || !callback} onClick={() => void act(true)}>Finish connection</button>
      </div>}
    </>}
    {done && <p role="status">Connected successfully.</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
