import { useId, type KeyboardEvent } from 'react';
import type { DetailMode } from '../../shared/edit';
import { DETAIL_MODE_TEXT } from '../../shared/i18n/fidelity';
import { useLang } from '../i18n/LanguageProvider';

const MODES: readonly DetailMode[] = ['concept', 'detailed'];

/**
 * The 細節程度 control (design-fidelity R23): a radio group with two options and a help text. It exposes
 * `data-detail-mode` for tests and is disabled while an agent run is active. The parent stores the choice.
 */
export function DetailModeSwitch({ value, onChange, disabled = false }: {
  value: DetailMode;
  onChange(mode: DetailMode): void;
  disabled?: boolean;
}) {
  const { lang } = useLang();
  const text = DETAIL_MODE_TEXT[lang];
  const labelId = useId();
  const helpId = useId();
  // Arrow keys move the choice, as in any radio group.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    onChange(MODES[(MODES.indexOf(value) + step + MODES.length) % MODES.length]!);
  };
  return <div className="fidelity-mode">
    <span className="fidelity-mode-label" id={labelId}>{text.label}</span>
    <div className="fidelity-mode-options" role="radiogroup" aria-labelledby={labelId} aria-describedby={helpId} data-detail-mode={value}>
      {MODES.map(mode => <button
        key={mode}
        type="button"
        role="radio"
        aria-checked={value === mode}
        tabIndex={value === mode ? 0 : -1}
        className={value === mode ? 'active' : ''}
        disabled={disabled}
        onKeyDown={onKeyDown}
        onClick={() => { if (value !== mode) onChange(mode); }}
      >{text[mode]}</button>)}
    </div>
    <p className="small-muted" id={helpId}>{text.help}</p>
  </div>;
}
