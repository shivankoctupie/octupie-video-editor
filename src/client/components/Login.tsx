import { useState } from "react";
import { api, setToken, type Me } from "../api";

/*
 * Sign-in. The operator issues a bearer token; the user pastes it. The token is validated by
 * a /api/me round-trip and, on success, held in sessionStorage for the tab only. It is never
 * shown in a URL or written to the console.
 */
export function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    setError("");
    setToken(t);
    const me = await api<Me>("/api/me");
    setBusy(false);
    if (me.status === 200 && me.json) {
      onSignedIn(me.json);
    } else {
      setToken("");
      setError("That token was not accepted. Check it with your operator.");
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brandmark">
          <BrandGlyph />
          <b>Octupie Video Editor</b>
        </div>
        <h1>Sign in</h1>
        <p className="muted">Local-first timeline editing, review, and publishing. Tokens are issued by your operator and never leave this tab.</p>
        {error ? <div className="notice bad">{error}</div> : null}
        <label className="field">
          <span>Access token</span>
          <input type="password" autoComplete="off" placeholder="Paste your access token" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        <button className="btn accent" type="submit" disabled={busy}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export function BrandGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#111111" />
      <circle cx="16" cy="16" r="8.5" fill="none" stroke="#F7F5F0" strokeWidth="3" />
      <circle cx="16" cy="16" r="2.6" fill="#014CE3" />
    </svg>
  );
}
