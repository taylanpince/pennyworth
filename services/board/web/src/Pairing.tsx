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

/** The phone's side: spend the code from the pairing link, or explain how to get one. */
export function PairScreen({ code, onPaired }: { code?: string; onPaired: () => void }) {
  const [state, setState] = useState<"idle" | "pairing" | "error">(code ? "pairing" : "idle");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!code) return;
    let live = true;
    api.pair(code, deviceName()).then(
      () => {
        if (!live) return;
        history.replaceState(null, "", "/#/"); // the code is spent; keep it out of history
        onPaired();
      },
      (e) => {
        if (!live) return;
        setState("error");
        setError((e as Error).message);
      },
    );
    return () => {
      live = false;
    };
  }, [code, onPaired]);
  return (
    <div className="pair-screen">
      <img src="/icon.png" alt="" />
      <h1>Pennyworth</h1>
      {state === "pairing" && <p>Pairing this device…</p>}
      {state === "error" && <p className="pair-error">{error}</p>}
      {state !== "pairing" && (
        <ol>
          <li>
            On your laptop, open the board at <b>localhost:3120</b>.
          </li>
          <li>
            Click <b>Phone</b> at the top.
          </li>
          <li>Scan the QR code with this phone's camera.</li>
        </ol>
      )}
    </div>
  );
}

/** The laptop's side: a one-time pairing QR code, and the devices paired so far. */
export function PhonePanel({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
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
            <p className="muted small">On the home Wi-Fi, scan this with the phone's camera. The link works once, for 10 minutes; the phone then stays paired.</p>
            <div className="qr">{qr ? <img src={qr} alt="Pairing QR code" width={240} height={240} /> : <span className="spinner" />}</div>
            {link && (
              <p className="small pair-link">
                <code>{link.url.replace(/\/#\/pair\/.*/, "")}</code> · expires {new Date(link.expiresAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
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
