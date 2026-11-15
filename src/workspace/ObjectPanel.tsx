import { MAX_OBJECTS, type ObjectTransform, type SceneObject } from '../../shared/workspace';
import { NumberField } from '../ui/NumberField';
import { OBJECT_NAME_MAX, objectRows } from './object-panel';

const MM = 1000;
const AXES = ['x', 'y', 'z'] as const;

interface Props {
  objects: SceneObject[];
  activeObjectId: string | null;
  /** True while an agent run is active: every control is disabled. */
  disabled: boolean;
  /** A rename that was rejected, shown inside the panel. */
  error?: string;
  onActivate: (id: string) => void;
  onRename: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onTransform: (id: string, patch: { position?: ObjectTransform['position']; rotation?: ObjectTransform['rotation'] }) => void;
}

/** The 物件 panel: switch, rename, move and delete the objects of the workspace. */
export function ObjectPanel({ objects, activeObjectId, disabled, error, onActivate, onRename, onRemove, onTransform }: Props) {
  const rows = objectRows({ objects, activeObjectId });
  const active = objects.find(object => object.id === activeObjectId) ?? null;
  const vector = (label: string, key: 'position' | 'rotation', object: SceneObject) => {
    const value = object.transform[key];
    const config = key === 'position' ? { scale: MM, min: -100_000, max: 100_000, unit: 'mm' } : { scale: 1, min: -360, max: 360, unit: '°' };
    return <fieldset className="vector-field"><legend>{label}<small>{config.unit}</small></legend>
      {AXES.map(axis => <NumberField key={axis} label={`${label} ${axis.toUpperCase()}`} value={value[axis]} scale={config.scale} min={config.min} max={config.max} digits={1} disabled={disabled}
        onCommit={number => onTransform(object.id, { [key]: { ...value, [axis]: number } })} />)}
    </fieldset>;
  };
  return <section className="panel objects-panel" aria-label="物件">
    <div className="panel-heading"><span className="eyebrow">OBJECTS</span><span className="tag">{objects.length} / {MAX_OBJECTS}</span></div>
    <h2>物件</h2>
    <ul className="object-picker" aria-label="物件清單">{rows.map(row => <li key={row.id}>
      <button type="button" aria-pressed={row.active} disabled={disabled} className={row.active ? 'selected' : ''} onClick={() => onActivate(row.id)}>
        <span>{row.name}<small>{row.partCount} 件</small></span></button></li>)}</ul>
    {error && <p className="notice warning" role="alert">{error}</p>}
    {active && <div className="object-editor">
      <label className="text-field"><span>名稱</span><input key={`name-${active.id}-${active.model.name}`} defaultValue={active.model.name} aria-label="物件名稱" maxLength={OBJECT_NAME_MAX} disabled={disabled}
        onBlur={event => { onRename(active.id, event.target.value); event.target.value = active.model.name; }}
        onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} /></label>
      {vector('物件位置', 'position', active)}
      {vector('物件角度', 'rotation', active)}
      <div className="button-group editor-actions"><button type="button" className="button danger" disabled={disabled} onClick={() => onRemove(active.id)}>刪除物件</button></div>
    </div>}
  </section>;
}
