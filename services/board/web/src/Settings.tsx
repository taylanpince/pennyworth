import { WhatsAppPanel } from "./WhatsApp";

export function SettingsPage() {
  return (
    <main className="settings-page" aria-labelledby="settings-title">
      <header className="settings-page-heading">
        <div>
          <h1 id="settings-title">Settings</h1>
          <p>Manage your connections and task intake.</p>
        </div>
        <a className="btn" href="#/">Back to board</a>
      </header>
      <WhatsAppPanel />
    </main>
  );
}
