import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export function NumberField({ label, value, scale = 1, min, max, digits = 1, disabled = false, onCommit }: {
  label: string; value: number; scale?: number; min: number; max: number; digits?: number; disabled?: boolean; onCommit: (value: number) => void;
}) {
  const shown = Number((value * scale).toFixed(digits)).toString();
  const [draft, setDraft] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setDraft(shown); setInvalid(false); }, [shown]);
  const commit = () => {
    const number = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(number) || number < min || number > max) { setInvalid(true); return; }
    setInvalid(false);
    if (number.toFixed(digits) !== Number(shown).toFixed(digits)) onCommit(number / scale);
  };
  return <label className={`number-field ${invalid ? 'invalid' : ''}`}><span>{label}</span>
    <input inputMode="decimal" value={draft} aria-label={label} aria-invalid={invalid} disabled={disabled}
      onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } else if (event.key === 'Escape') { setDraft(shown); setInvalid(false); } }} />
  </label>;
}
