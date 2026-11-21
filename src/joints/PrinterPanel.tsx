import { DEFAULT_PRINTER_PROFILE, type PrinterProfile } from '../../shared/printer';
import { NumberField } from '../ui/NumberField';

interface Props {
  profile: PrinterProfile;
  onChange: (profile: PrinterProfile) => void;
}

/** The five fields: name, key, allowed range (the same as `PrinterProfileSchema`). */
const FIELDS: ReadonlyArray<{ label: string; key: keyof PrinterProfile; min: number; max: number }> = [
  { label: '滑配間隙（每側）', key: 'slidingFit', min: 0, max: 1 },
  { label: '壓配間隙（每側）', key: 'pressFit', min: 0, max: 0.5 },
  { label: '孔徑補償', key: 'holeCompensation', min: 0, max: 1 },
  { label: '深度補償', key: 'depthAllowance', min: 0, max: 1 },
  { label: 'PETG 額外間隙（每側）', key: 'petgExtra', min: 0, max: 0.5 },
];

const sameProfile = (a: PrinterProfile, b: PrinterProfile) => FIELDS.every(field => a[field.key] === b[field.key]);

/**
 * 列印設定 (requirement 19): the printer's tolerances in millimetres. A change applies at once to every
 * hole, marker and check, and is stored in the browser by the caller. Not an undo step.
 */
export function PrinterPanel({ profile, onChange }: Props) {
  return <details className="panel printer-panel" aria-label="列印設定" data-testid="printer-panel">
    <summary>列印設定<span className="tag">公差 mm</span></summary>
    <div className="printer-fields">
      {FIELDS.map(field => <NumberField key={field.key} label={field.label} value={profile[field.key]} min={field.min} max={field.max} digits={2}
        onCommit={value => onChange({ ...profile, [field.key]: value })} />)}
    </div>
    <p className="small-muted">公差會因印表機與線材而不同。請先列印公差測試件，再依結果調整這些數值。</p>
    <button type="button" className="button" disabled={sameProfile(profile, DEFAULT_PRINTER_PROFILE)} onClick={() => onChange({ ...DEFAULT_PRINTER_PROFILE })}>恢復預設值</button>
  </details>;
}
