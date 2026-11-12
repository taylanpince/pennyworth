import { useEffect, useState } from "react";
type Status = {
  state: string;
  qr: string | null;
  selected: number;
  mode?: "selected" | "attention";
  taskEmoji?: string;
};
type Chat = {
  id: string;
  name: string;
  selected: number;
  mode?: "selected" | "attention";
  taskEmoji?: string;
};
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api/whatsapp/${path}`, {
    method,
    headers: { "content-type": "application/json", "x-pennyworth-board": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error("WhatsApp is unavailable. Try again shortly.");
  return res.json();
}
export function WhatsAppPanel() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    void request<Status>("status")
      .then((s) => {
        setStatus(s);
        setAvailable(true);
      })
      .catch(() => {});
  }, []);
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<Status | null>(null),
    [chats, setChats] = useState<Chat[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  async function refresh() {
    const s = await request<Status>("status");
    setStatus(s);
    return s;
  }
  async function loadChats() {
    const c = await request<{ chats: Chat[] }>("chats");
    setChats(c.chats);
    setSelected(c.chats.filter((c) => c.selected).map((c) => c.id));
  }
  useEffect(() => {
    if (!open) return;
    let live = true;
    const poll = () =>
      request<Status>("status")
        .then((s) => {
          if (live) setStatus(s);
        })
        .catch(() => {
          if (live) setError("WhatsApp is unavailable. Try again shortly.");
        });
    void poll();
    void loadChats().catch(() => {});
    const timer = setInterval(poll, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [open]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    setSaved(false);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!available) return null;
  return (
    <section className="alert">
      <div className="alert-row">
        <span>
          WhatsApp
          {status
            ? ` · ${status.state} · ${status.mode === "attention" ? "all chats" : `${status.selected} selected chats`}`
            : ""}
        </span>
        <button className="btn" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Settings"}
        </button>
      </div>
      {open && (
        <div>
          <p>
            {status?.mode === "attention" ? (
              <>
                Watching all chats. Mentions of you, replies to your messages,
                and messages you react to with {status.taskEmoji || "📌"} become
                tasks. Removing that reaction closes a pin-only task; replying
                to an ask closes its response task.
              </>
            ) : (
              <>
                Connect WhatsApp, then select the conversations to watch. You
                can change this list at any time.
              </>
            )}
          </p>
          {error && <p role="alert">{error}</p>}
          {status?.state !== "connected" && (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void act(() => request("connect", "POST"))}
            >
              Connect WhatsApp
            </button>
          )}
          {status?.qr && (
            <div>
              <p>
                In WhatsApp, open Settings → Linked Devices → Link a Device,
                then scan this code from another screen.
              </p>
              <img
                src={status.qr}
                alt="Scan to link WhatsApp to Manor"
                width="256"
                height="256"
              />
            </div>
          )}
          {status?.state === "connected" && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await request("disconnect", "POST");
                  await loadChats();
                })
              }
            >
              Disconnect
            </button>
          )}
          {status?.mode !== "attention" && (
            <>
              <p>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => void act(loadChats)}
                >
                  Refresh chat list
                </button>
              </p>
              <label>
                Find a chat{" "}
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                {chats
                  .filter((c) =>
                    `${c.name} ${c.id}`
                      .toLowerCase()
                      .includes(query.toLowerCase()),
                  )
                  .map((c) => (
                    <label key={c.id} style={{ display: "block", padding: 8 }}>
                      <input
                        type="checkbox"
                        checked={selected.includes(c.id)}
                        onChange={(e) => {
                          setSaved(false);
                          setSelected(
                            e.target.checked
                              ? [...selected, c.id]
                              : selected.filter((id) => id !== c.id),
                          );
                        }}
                      />{" "}
                      {c.name}
                    </label>
                  ))}
              </div>
              {!chats.length && (
                <p>
                  Chats appear after linking and syncing. Refresh the list after
                  a few moments.
                </p>
              )}
              <button
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await request("chats", "PUT", { ids: selected });
                    setSaved(true);
                  })
                }
              >
                Save selected chats ({selected.length})
              </button>
              {saved && (
                <p role="status">
                  Saved. Only selected chats feed Manor. Retained messages from
                  deselected chats have been removed.
                </p>
              )}
            </>
          )}
          <p>
            Text, links and captions are supported. Voice notes and media
            downloads are not connected yet.
          </p>
        </div>
      )}
    </section>
  );
}
