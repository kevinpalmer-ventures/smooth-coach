import { useMemo, useState, type FormEvent } from "react";
import type { AccountUser, WeightEntry } from "./types";

type WeightTrackerProps = {
  user: AccountUser | null;
  loading: boolean;
  weights: WeightEntry[];
  onLogin: () => void;
  onSave: (entry: { weight: number; unit: "lb" | "kg"; loggedAt: string }) => Promise<void>;
};

const today = () => new Date().toISOString().slice(0, 10);

export default function WeightTracker({ user, loading, weights, onLogin, onSave }: WeightTrackerProps) {
  const [weight, setWeight] = useState("");
  const [unit, setUnit] = useState<"lb" | "kg">("lb");
  const [loggedAt, setLoggedAt] = useState(today());
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const lockedUnit = weights[0]?.unit;

  const summary = useMemo(() => {
    if (!weights.length) return null;
    const first = weights[0];
    const latest = weights[weights.length - 1];
    const difference = Number((latest.weight - first.weight).toFixed(2));
    const min = Math.min(...weights.map((entry) => entry.weight));
    const max = Math.max(...weights.map((entry) => entry.weight));
    const range = max - min;
    const positions = weights.map((entry, index) => {
      const x = weights.length === 1 ? 50 : (index / (weights.length - 1)) * 100;
      const y = range === 0 ? 50 : 90 - ((entry.weight - min) / range) * 80;
      return { x, y };
    });
    const points = positions.map(({ x, y }) => `${x},${y}`).join(" ");
    return { first, latest, difference, points, positions };
  }, [weights]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericWeight = Number(weight);
    if (!Number.isFinite(numericWeight) || numericWeight <= 0) {
      setMessage("Enter a positive weight to save your check-in.");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      await onSave({ weight: numericWeight, unit: lockedUnit ?? unit, loggedAt });
      setWeight("");
      setMessage("Saved privately to your account.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save this weight right now.");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <section className="weight-card weight-loading"><p className="eyebrow">Personal progress</p><h3>Loading your private timeline…</h3></section>;
  }

  if (!user) {
    return (
      <section className="weight-card weight-locked">
        <div><p className="eyebrow">Personal progress</p><h3>Keep your weight timeline private.</h3><p>Sign in to add dated weight entries and see a progression chart that belongs only to your account.</p></div>
        <button onClick={onLogin}>Sign in to track <span>→</span></button>
      </section>
    );
  }

  return (
    <section className="weight-card" aria-labelledby="weight-tracker-title">
      <div className="weight-card-heading">
        <div><p className="eyebrow">Personal progress</p><h3 id="weight-tracker-title">Your weight timeline</h3><p>Private to {user.name || "your"} account. This is a simple self-record, not a clinical assessment.</p></div>
        <span className="private-badge">⌁ private</span>
      </div>

      <div className="weight-layout">
        <form className="weight-form" onSubmit={(event) => void submit(event)}>
          <label><span>Weight</span><input type="number" min="0.1" max="1000" step="0.1" value={weight} onChange={(event) => setWeight(event.target.value)} placeholder="e.g. 154.2" required /></label>
          <label><span>Unit</span><select value={lockedUnit ?? unit} onChange={(event) => setUnit(event.target.value as "lb" | "kg")} disabled={Boolean(lockedUnit)}><option value="lb">lb</option><option value="kg">kg</option></select></label>
          <label><span>Date</span><input type="date" value={loggedAt} max={today()} onChange={(event) => setLoggedAt(event.target.value)} required /></label>
          <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save check-in"}</button>
          <small>{lockedUnit ? `Using ${lockedUnit} to keep your chart consistent. Saving the same date updates that entry.` : "Choose a unit for your timeline. It stays consistent after your first entry."}</small>
          {message && <p className="weight-message" role="status">{message}</p>}
        </form>

        {summary ? (
          <div className="weight-summary">
            <div className="weight-stats"><div><span>Latest</span><strong>{summary.latest.weight} {summary.latest.unit}</strong><small>{summary.latest.loggedAt}</small></div><div><span>Since first entry</span><strong className={summary.difference === 0 ? "neutral" : summary.difference < 0 ? "down" : "up"}>{summary.difference > 0 ? "+" : ""}{summary.difference} {summary.latest.unit}</strong><small>{summary.first.loggedAt} → {summary.latest.loggedAt}</small></div></div>
            <div className="weight-chart" aria-label={`Weight chart with ${weights.length} logged ${weights.length === 1 ? "entry" : "entries"}`}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-hidden="true"><defs><linearGradient id="weightFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#789B7B" stopOpacity=".28"/><stop offset="100%" stopColor="#789B7B" stopOpacity="0"/></linearGradient></defs><polyline points={`0,100 ${summary.points} 100,100`} fill="url(#weightFill)" stroke="none"/><polyline points={summary.points} fill="none" stroke="#4F7654" strokeWidth="2.3" vectorEffect="non-scaling-stroke"/></svg>
              <div className="chart-dots">{weights.map((entry, index) => <span key={entry.id} title={`${entry.loggedAt}: ${entry.weight} ${entry.unit}`} style={{ left: `${summary.positions[index].x}%`, top: `${Math.max(8, Math.min(89, summary.positions[index].y))}%` }} />)}</div>
            </div>
          </div>
        ) : <div className="weight-empty"><span>◌</span><p>Your first check-in will start a private timeline here.</p></div>}
      </div>

      {weights.length > 0 && <div className="weight-history"><span>Recent entries</span>{weights.slice(-3).reverse().map((entry) => <p key={entry.id}><b>{entry.loggedAt}</b><strong>{entry.weight} {entry.unit}</strong></p>)}</div>}
    </section>
  );
}
