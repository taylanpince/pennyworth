import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api, type Device } from "./api";
import { CloseIcon } from "./components";
import { ago } from "./util";

/** A short name for this device, shown in the laptop's list of paired devices. */
function deviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /CriOS|Chrome/.test(ua) ? "Chrome" : /FxiOS|Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "";
  return [os, browser].filter(Boolean).join(" · ");
}

/** "K7QM3XWP" → "K7QM-3XWP". */
export const formatCode = (code: string) => code.replace(/^(.{4})(.+)$/, "$1-$2");

/**
 * The phone's side. A pairing link only fills in the code: pairing waits for a tap, so a QR
 * scanner's in-app browser doesn't spend the code before the link reaches Safari. Without a
 * link, type the code shown on the laptop.
 */
export function PairScreen({ code: linked, onPaired }: { code?: string; onPaired: () => void }) {
  const [code, setCode] = useState(linked ? formatCode(linked) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function pair() {
    if (busy || code.replace(/[^a-z0-9]/gi, "").length < 8) return;
    setBusy(true);
    setError("");
    try {
      await api.pair(code, deviceName());
      history.replaceState(null, "", "/#/"); // the code is spent; keep it out of history
      onPaired();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pair-screen">
      <img src="/icon.png" alt="" />
      <h1>Pennyworth</h1>
      <p className="muted">
        {linked ? "Pair this phone with your board." : (
          <>
            On your laptop's board, click <b>Phone</b>, then type the code shown there.
          </>
        )}
      </p>
      <form
        className="pair-form"
        onSubmit={(e) => {
          e.preventDefault();
          void pair();
        }}
      >
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="XXXX-XXXX"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          maxLength={12}
          aria-label="Pairing code"
        />
        <button className="btn primary" disabled={busy || code.replace(/[^a-z0-9]/gi, "").length < 8}>
          {busy ? "Pairing…" : "Pair this phone"}
        </button>
      </form>
      {error && <p className="pair-error">{error}</p>}
      {linked && <p className="muted small">In a scanner app? Open this page in Safari first, then tap Pair: the phone is paired in the browser you pair it from.</p>}
    </div>
  );
}

/** The laptop's side: a one-time pairing QR code, and the devices paired so far. */
export function PhonePanel({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState<{ url: string; base: string; code: string; expiresAt: string } | null>(null);
  const [qr, setQr] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [error, setError] = useState("");

  const loadDevices = () => api.devices().then(setDevices, () => {});
  async function newLink() {
    try {
      const l = await api.pairing();
      setLink(l);
      setQr(await QRCode.toDataURL(l.url, { margin: 1, width: 240, errorCorrectionLevel: "M" }));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void newLink();
    void loadDevices();
    const t = setInterval(loadDevices, 3000); // shows the phone as soon as it pairs
    return () => clearInterval(t);
  }, []);

  return (
    <div className="drawer-backdrop center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="help phone-panel" role="dialog" aria-label="Pair a phone">
        <header className="row-between">
          <h2>Open the board on your phone</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        {error ? (
          <p className="pair-error">{error}</p>
        ) : (
          <>
            <p className="muted small">On the home Wi-Fi, open <b>{link?.base.replace(/^https?:\/\//, "") ?? "the board"}</b> in Safari on the phone and type this code, or scan the QR code. It works once, for 10 minutes; the phone then stays paired.</p>
            {link && <div className="pair-code">{formatCode(link.code)}</div>}
            <div className="qr">{qr ? <img src={qr} alt="Pairing QR code" width={240} height={240} /> : <span className="spinner" />}</div>
            {link && (
              <p className="small pair-link">
                <code>{link.base}</code> · expires {new Date(link.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                <button className="link-btn" onClick={() => void newLink()}>
                  New code
                </button>
              </p>
            )}
          </>
        )}
        <h3>Paired devices</h3>
        {devices.length === 0 && <p className="muted small">None yet.</p>}
        {devices.map((d) => (
          <div key={d.id} className="device">
            <span>{d.device}</span>
            <span className="muted small">{ago(d.lastSeen) === "now" ? "active now" : `used ${ago(d.lastSeen)} ago`}</span>
            <span className="spacer" />
            <button className="btn" onClick={() => void api.revokeDevice(d.id).then(loadDevices)}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
