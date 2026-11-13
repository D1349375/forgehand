import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { demoModel } from '../shared/demo';
import { applyEditPlan, describeChanges, editConflicts, EditError, EditResultSchema, validateEditPlan, type EditPlan, type EditResult } from '../shared/edit';
import { validateGenerationResult, validateModel, type GenerationResult, type ModelSpec, type Part } from '../shared/model';
import { SceneViewport, type SceneHandle, type TransformMode, type Vector } from './scene/SceneViewport';
import { useArmTracking, type ArmTrackingStatus } from './try-on/useArmTracking';
import type { AgentTurn } from '../shared/agent';
import { AgentPanel } from './agent/AgentPanel';
import { HISTORY_TURN_LIMIT } from './agent/request';
import type { DisplayModel } from './agent/types';
import { useAgentRun } from './agent/useAgentRun';

type ServiceStatus = { configured: boolean; provider: string; model: string; reason?: string };
const providerLabel = (provider?: string) => provider === 'codex' ? 'Codex CLI' : provider === 'claude' ? 'Claude Code CLI' : 'OpenAI API';
type Pending = { result: GenerationResult; startedAt: number };
/** `lineage` is the object the AI answer was made for; undo/redo may leave it while the dialog is open. */
type Conflict = { result: EditResult; parts: Part[]; startedAt: number; lineage: string };
type Busy = null | 'generate' | 'edit';
const HISTORY_LIMIT = 50;
const MM = 1000;
const armStatusText: Record<ArmTrackingStatus, string> = {
  off: '正在開啟攝影機。',
  loading: '正在載入手部追蹤模型（第一次約 20–30 秒）。',
  searching: '讓手掌和手腕入鏡；手肘也入鏡時，前臂方向更準。',
  tracking: '護臂已對齊。試著翻掌或移動前臂。',
  'load-error': '無法載入手部追蹤模型。請確認網路連線，結束後重新開啟試戴。',
  'track-error': '視訊追蹤已中斷。請結束後重新開啟試戴。',
};

declare global { interface Window { __forgehandScene?: SceneHandle | null } }

function NumberField({ label, value, scale = 1, min, max, digits = 1, disabled = false, onCommit }: {
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

export default function App() {
  const [prompt, setPrompt] = useState('一個紅色、有四條腿的小桌子');
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<'edit' | 'create'>('create');
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [display, setDisplay] = useState<DisplayModel | null>(null);
  const [history, setHistory] = useState<{ past: DisplayModel[]; future: DisplayModel[] }>({ past: [], future: [] });
  const [selected, setSelected] = useState<string[]>([]);
  const [transformMode, setTransformMode] = useState<TransformMode>(null);
  /** Exploded-view amount (0–1). Display state only: never part of the model or undo history. */
  const [explode, setExplode] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState('先開啟攝影機，再描述你想看見的物件。');
  const [error, setError] = useState('');
  const [clarify, setClarify] = useState('');
  const [editSummary, setEditSummary] = useState<{ changes: string; explanation: string } | null>(null);
  const [adjustError, setAdjustError] = useState('');
  const [renderError, setRenderError] = useState('');
  const [timing, setTiming] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [camera, setCamera] = useState<'off' | 'starting' | 'on'>('off');
  /** Show the camera like a mirror (the user's left stays on the left). Only a rear camera is shown as-is. */
  const [mirrored, setMirrored] = useState(true);
  const [cameraError, setCameraError] = useState('');
  const [tryingOn, setTryingOn] = useState(false);
  const [contrast, setContrast] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tryOnActive = tryingOn && camera === 'on';
  const armTracking = useArmTracking(videoRef, tryOnActive, mirrored);
  const sceneRef = useRef<SceneHandle>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequest = useRef(0);
  const latest = useRef(0);
  const requestStarted = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const currentDisplay = useRef(display);
  const lastRendered = useRef<DisplayModel | null>(null);
  currentDisplay.current = display;
  const lastFailed = useRef<'generate' | 'edit'>('generate');
  /** The latest completed agent turns, newest last, sent as history so follow-ups have context. */
  const agentTurns = useRef<AgentTurn[]>([]);
  const agent = useAgentRun({
    commit: commitFromAgent,
    setSelected,
    setExplode: setExplodeAmount,
    setTryingOn,
    getSnapshot: () => ({ display: currentDisplay.current, selectedPartIds: selected, explode, tryOn: tryingOn, cameraOn: camera === 'on' }),
    getTurns: () => agentTurns.current,
    pushTurn: turn => { agentTurns.current = [...agentTurns.current, turn].slice(-HISTORY_TURN_LIMIT); },
  });
  /** While an agent run is active the user can only watch or cancel: manual changes would race its edits. */
  const agentActive = agent.active;

  async function refreshService() {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error();
      setService(await response.json() as ServiceStatus);
    } catch { setService(null); }
  }
  useEffect(() => {
    void refreshService();
    return () => {
      latest.current++;
      controller.current?.abort();
      cameraRequest.current++;
      streamRef.current?.getTracks().forEach(track => track.stop());
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setElapsed((performance.now() - requestStarted.current) / 1000), 200);
    return () => window.clearInterval(timer);
  }, [busy]);
  // Exposed only to automated browsers so tests can click a specific part.
  useEffect(() => { if (navigator.webdriver) window.__forgehandScene = sceneRef.current; return () => { if (navigator.webdriver) window.__forgehandScene = null; }; }, []);

  /** Every change to the displayed model goes through here so it can be undone. */
  function commit(next: DisplayModel) {
    const previous = currentDisplay.current;
    if (previous) setHistory(state => ({ past: [...state.past, previous].slice(-HISTORY_LIMIT), future: [] }));
    if (!previous || previous.lineage !== next.lineage) { setSelected([]); setTransformMode(null); setExplode(0); }
    currentDisplay.current = next;
    setDisplay(next);
  }
  function restore(target: DisplayModel, label: string) {
    const sameObject = currentDisplay.current?.lineage === target.lineage;
    const available = new Set(target.model.parts.map(part => part.id));
    const kept = sameObject ? selected.filter(id => available.has(id)) : [];
    setSelected(kept);
    if (kept.length !== selected.length) setTransformMode(null);
    currentDisplay.current = target;
    setDisplay(target); setTiming(null); setAdjustError(''); setEditSummary(null);
    setMessage(label);
  }
  function undo() {
    if (agentActive) return;
    const current = currentDisplay.current;
    const previous = history.past.at(-1);
    if (!current || !previous) return;
    setHistory(state => ({ past: state.past.slice(0, -1), future: [current, ...state.future].slice(0, HISTORY_LIMIT) }));
    restore(previous, '已復原上一步。');
  }
  function redo() {
    if (agentActive) return;
    const current = currentDisplay.current;
    const next = history.future[0];
    if (!current || !next) return;
    setHistory(state => ({ past: [...state.past, current].slice(-HISTORY_LIMIT), future: state.future.slice(1) }));
    restore(next, '已重做。');
  }

  async function startCamera(facingMode: 'environment' | 'user' = 'environment') {
    const id = ++cameraRequest.current;
    setCamera('starting'); setCameraError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('unsupported');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      if (id !== cameraRequest.current) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = stream;
      setMirrored(stream.getVideoTracks()[0]?.getSettings().facingMode !== 'environment');
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      if (id !== cameraRequest.current) return;
      stream.getVideoTracks().forEach(track => { track.onended = () => { if (streamRef.current === stream) { stopCamera(); setCameraError('攝影機連線已中斷，請重新開啟。'); } }; });
      setCamera('on');
    } catch (cause) {
      if (id !== cameraRequest.current) return;
      streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
      setCamera('off');
      setTryingOn(false);
      const name = cause instanceof DOMException ? cause.name : '';
      setCameraError(name === 'NotAllowedError' || name === 'SecurityError'
        ? '攝影機授權遭拒。請在瀏覽器網址列允許攝影機後，重新開啟。你仍可操作 3D 模型。'
        : name === 'NotFoundError' ? '找不到攝影機。請連接設備後重新開啟。'
        : name === 'NotReadableError' ? '攝影機可能正被其他程式使用。請關閉佔用程式後重試。'
        : '無法開啟攝影機。請確認使用 localhost、安全連線與可用的攝影機，再重新開啟。');
    }
  }
  function stopCamera() {
    cameraRequest.current++;
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera('off');
    setTryingOn(false);
  }
  function toggleTryOn() {
    if (agentActive) return;
    if (tryingOn) {
      if (camera === 'starting') stopCamera();
      else setTryingOn(false);
      return;
    }
    setTryingOn(true);
    if (camera === 'off') void startCamera('user');
  }
  function invalidateRequest() {
    latest.current++; controller.current?.abort(); controller.current = null;
    setBusy(null); setPending(null); setConflict(null); setElapsed(0);
  }
  function applyResult(result: GenerationResult, startedAt: number) {
    if (!result.design.model) return;
    setRenderError(''); setTiming(null); setEditSummary(null); setClarify('');
    commit({ model: result.design.model, source: result.source, providerModel: result.model, requestId: result.requestId, startedAt, lineage: crypto.randomUUID(), edited: false });
    setMode('edit');
    setMessage('資料驗證完成，正在建立 3D 草案。');
  }

  /** Shared request lifecycle for generation and AI edits. */
  async function callModel<T>(kind: 'generate' | 'edit', url: string, payload: unknown, accept: (body: unknown, requestId: string, startedAt: number) => void) {
    const id = ++latest.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const requestId = crypto.randomUUID(); const startedAt = performance.now();
    requestStarted.current = startedAt; lastFailed.current = kind;
    setPending(null); setConflict(null); setError(''); setClarify(''); setBusy(kind); setElapsed(0);
    setMessage(kind === 'edit' ? '正在理解修改指示，模型仍可旋轉、選取與調整。' : '正在理解描述並建立模型資料，現有模型仍可操作。');
    // Let the server's configurable timeout (max 300s) and process cleanup
    // return a meaningful error before using this final network fallback.
    const timeout = window.setTimeout(() => abort.abort('timeout'), 340_000);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload as object, requestId }), signal: abort.signal });
      const body: unknown = await response.json();
      if (id !== latest.current) return;
      if (!response.ok) {
        const details = body as { error?: { message?: string } };
        throw new Error(details.error?.message || '模型服務未完成，請重試。');
      }
      accept(body, requestId, startedAt);
    } catch (cause) {
      if (id !== latest.current) return;
      const retained = currentDisplay.current ? (kind === 'edit' ? '目前模型未變更。' : '已保留上一個成功模型。') : '目前尚未建立模型。';
      setError(abort.signal.aborted ? `這次${kind === 'edit' ? '修改' : '生成'}已逾時，${retained}可重試或簡化描述。`
        : cause instanceof SyntaxError ? `模型服務回覆資料無法讀取，${retained}請重試。`
        : cause instanceof TypeError ? `無法連線到本機模型服務，${retained}請確認工作台仍在執行後重試。`
        : cause instanceof Error ? cause.message : '請求失敗，請重試。');
      setMessage(currentDisplay.current ? `${kind === 'edit' ? '修改' : '生成'}未完成，目前模型仍可操作。` : '生成未完成，目前尚未建立模型。');
    } finally { window.clearTimeout(timeout); if (id === latest.current) { setBusy(null); controller.current = null; } }
  }

  async function generate() {
    if (agentActive) return;
    if (!prompt.trim()) { setError('請先描述想建立的物件。'); return; }
    await callModel('generate', '/api/generate', { prompt: prompt.trim() }, (body, requestId, startedAt) => {
      let result: GenerationResult;
      try { result = validateGenerationResult(body); }
      catch { throw new Error('模型服務返回無效資料，已保留上一個成功模型。請重試或調整描述。'); }
      if (result.requestId !== requestId) throw new Error('模型回應與目前請求不符，已保留上一個成功模型。');
      setService({ configured: true, provider: result.source, model: result.model });
      if (result.design.status === 'unsupported') { setError(result.design.explanation); setMessage('目前描述尚未建立模型。'); return; }
      if (result.design.status === 'approximation') { setPending({ result, startedAt }); setMessage('這份描述需要近似處理，請先確認方案。'); return; }
      applyResult(result, startedAt);
    });
  }

  function applyEdit(plan: EditPlan, result: EditResult, startedAt: number, lineage: string) {
    const target = currentDisplay.current;
    if (!target) return;
    if (target.lineage !== lineage) {
      setConflict(null);
      setError('目前顯示的已是另一個物件，這次 AI 修改沒有套用。');
      setMessage('修改未套用，目前模型仍可操作。');
      return;
    }
    try {
      const { model, changes } = applyEditPlan(target.model, plan);
      setRenderError(''); setTiming(null); setConflict(null);
      commit({ ...target, model, source: result.source, providerModel: result.model, requestId: result.requestId, startedAt, edited: true });
      setSelected([...changes.added, ...changes.updated]);
      setEditSummary({ changes: describeChanges(target.model, model, changes), explanation: plan.explanation });
      setInstruction('');
      setMessage('修改已套用，可按「復原」回到上一步。');
    } catch (cause) {
      setConflict(null);
      setError(`${cause instanceof EditError ? cause.message : '修改無法套用。'}目前模型未變更。`);
      setMessage('修改未套用，目前模型仍可操作。');
    }
  }

  async function edit() {
    if (agentActive) return;
    const base = currentDisplay.current;
    if (!base) { setError('請先生成或載入一個模型。'); return; }
    if (!instruction.trim()) { setError('請輸入想怎麼修改目前模型。'); return; }
    const selection = selected.filter(id => base.model.parts.some(part => part.id === id));
    await callModel('edit', '/api/edit', { instruction: instruction.trim(), model: base.model, selectedPartIds: selection }, (body, requestId, startedAt) => {
      let result: EditResult;
      try { result = EditResultSchema.parse(body) as EditResult; result.plan = validateEditPlan(result.plan); }
      catch { throw new Error('模型服務返回無效的修改資料，目前模型未變更。請重試或換個說法。'); }
      if (result.requestId !== requestId) throw new Error('模型回應與目前請求不符，目前模型未變更。');
      setService({ configured: true, provider: result.source, model: result.model });
      const { plan } = result;
      if (plan.status === 'clarify') { setClarify(plan.explanation); setMessage('需要你補充一點資訊，目前模型未變更。'); return; }
      if (plan.status === 'unsupported') { setError(plan.explanation); setMessage('這次修改無法處理，目前模型未變更。'); return; }
      const current = currentDisplay.current;
      if (!current || current.lineage !== base.lineage) {
        setError('等待期間已換成另一個模型，這次修改沒有套用。'); setMessage('修改未套用，目前模型仍可操作。'); return;
      }
      const parts = editConflicts(base.model, current.model, plan);
      if (parts.length) { setConflict({ result, parts, startedAt, lineage: base.lineage }); setMessage('AI 修改與你剛才的手動調整有衝突，請選擇要保留哪一個。'); return; }
      applyEdit(plan, result, startedAt, base.lineage);
    });
  }

  function loadDemo() {
    if (agentActive) return;
    invalidateRequest(); setError(''); setRenderError(''); setTiming(null); setEditSummary(null); setClarify('');
    commit({ model: demoModel, source: 'demo', providerModel: '本機示範資料', requestId: 'demo', startedAt: null, lineage: crypto.randomUUID(), edited: false });
    setMode('edit');
    setMessage('已載入預先建立的示範模型，這不是 AI 生成結果。');
  }

  /** A model committed by the agent: drop dialogs and notices that belonged to the old model, like applyResult/applyEdit. */
  function commitFromAgent(next: DisplayModel) {
    setPending(null); setConflict(null); setEditSummary(null); setClarify('');
    setTiming(null); setRenderError('');
    commit(next);
    if (!next.edited) setMode('edit');
    setMessage(next.edited ? '代理已修改模型，可按「復原」回到上一步。' : '代理已建立新模型，可按「復原」回到上一步。');
  }

  /** Local, immediate change; validated exactly like AI output before display. */
  function adjust(next: ModelSpec, label: string) {
    const current = currentDisplay.current;
    if (!current) return;
    try {
      const model = validateModel(next);
      setAdjustError(''); setEditSummary(null); setTiming(null); setRenderError('');
      commit({ ...current, model, requestId: 'manual', startedAt: null, edited: true });
      setMessage(label);
    } catch (cause) {
      setAdjustError(`這個調整未通過資料驗證，未套用。${cause instanceof Error ? cause.message.slice(0, 120) : ''}`);
    }
  }
  function updatePart(id: string, patch: Partial<Part>, label = '已調整零件，可按「復原」回到上一步。') {
    if (agentActive) return;
    const current = currentDisplay.current;
    if (!current) return;
    adjust({ ...current.model, parts: current.model.parts.map(part => part.id === id ? { ...part, ...patch } : part) }, label);
  }
  function removeSelected() {
    if (agentActive) return;
    const current = currentDisplay.current;
    if (!current || !selected.length) return;
    const removing = new Set(selected);
    const child = current.model.parts.find(part => part.parentId && removing.has(part.parentId) && !removing.has(part.id));
    if (child) { setAdjustError(`「${child.name}」仍依附在要刪除的零件上，請先刪除或調整子零件。`); return; }
    if (removing.size >= current.model.parts.length) { setAdjustError('模型至少需要保留一個零件。'); return; }
    adjust({ ...current.model, parts: current.model.parts.filter(part => !removing.has(part.id)) }, `已刪除 ${selected.length} 個零件，可按「復原」回到上一步。`);
    setSelected([]); setTransformMode(null);
  }
  function pick(id: string | null, additive: boolean) {
    if (agentActive) return;
    setAdjustError('');
    if (!id) { if (!additive) setSelected([]); return; }
    setSelected(ids => additive ? (ids.includes(id) ? ids.filter(entry => entry !== id) : [...ids, id]) : (ids.length === 1 && ids[0] === id ? ids : [id]));
  }
  function setExplodeAmount(amount: number) {
    setExplode(amount);
    if (amount > 0) setTransformMode(null);
  }
  function onTransform(id: string, position: Vector, rotation: Vector) {
    if (agentActive) return;
    updatePart(id, { position, rotation }, transformMode === 'rotate' ? '已旋轉零件，可按「復原」回到上一步。' : '已移動零件，可按「復原」回到上一步。');
  }

  // Keyboard shortcuts never fire while typing in a field.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (agentActive) return; // undo, redo, Escape and Delete all change the model or selection
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); }
      else if (event.key === 'Escape') { setSelected([]); setTransformMode(null); }
      else if (event.key === 'Delete' && selected.length) { event.preventDefault(); removeSelected(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const editing = mode === 'edit' && Boolean(display);
  const selectedParts = display ? selected.map(id => display.model.parts.find(part => part.id === id)).filter((part): part is Part => Boolean(part)) : [];
  const single = selectedParts.length === 1 ? selectedParts[0]! : null;
  const sourceBase = display?.source === 'demo' ? '示範資料 · 非 AI 生成' : `${providerLabel(display?.source)} 生成`;
  const sourceLabel = display?.edited ? `${sourceBase} · 已修改` : sourceBase;
  const busyText = busy ? `${message}（${elapsed.toFixed(1)} 秒）` : message;
  const vector = (label: string, value: Vector, key: 'dimensions' | 'position' | 'rotation') => {
    const config = key === 'rotation' ? { scale: 1, min: -360, max: 360, digits: 1, unit: '°' }
      : key === 'dimensions' ? { scale: MM, min: 1, max: 100_000, digits: 1, unit: 'mm' } : { scale: MM, min: -100_000, max: 100_000, digits: 1, unit: 'mm' };
    return <fieldset className="vector-field"><legend>{label}<small>{config.unit}</small></legend>
      {(['x', 'y', 'z'] as const).map(axis => <NumberField key={axis} label={`${label} ${axis.toUpperCase()}`} value={value[axis]} scale={config.scale} min={config.min} max={config.max} digits={config.digits} disabled={agentActive}
        onCommit={number => single && updatePart(single.id, { [key]: { ...value, [axis]: number } } as Partial<Part>)} />)}
    </fieldset>;
  };

  return <div className="app-shell">
    <header className="topbar"><a className="brand" href="/" aria-label="Forgehand 工作台首頁"><span className="brand-icon">F</span><span>FORGEHAND<small>VOICE &amp; HAND 3D WORKBENCH</small></span></a><div className="phase-label"><span className="status-dot" />第二階段<span className="phase-divider">/</span>選取 · 調整 · 文字修改</div></header>
    <main className="workspace">
      <section className="stage-column" aria-label="3D 與視訊展示">
        <div className="section-heading"><div><span className="eyebrow">LIVE WORKSPACE</span><h1>把想法，放進視野。</h1></div><span className={`camera-badge ${camera === 'on' ? 'active' : ''}`}><span className="status-dot" />{camera === 'on' ? '攝影機已開啟' : camera === 'starting' ? '連接攝影機中' : '攝影機未開啟'}</span></div>
        <div className={`viewport ${contrast ? 'high-contrast' : ''}`} data-testid="viewport">
          <video ref={videoRef} muted playsInline autoPlay className={`camera-video ${camera === 'on' ? 'visible' : ''} ${mirrored ? 'mirrored' : ''}`} data-mirrored={mirrored} aria-label="即時攝影機背景" />
          <div className="viewport-shade" />
          <SceneViewport ref={sceneRef} model={display?.model ?? null} fitKey={display?.lineage ?? null} selectedIds={selected} transformMode={agentActive ? null : transformMode} explode={explode}
            tryOn={tryOnActive ? armTracking.sample : undefined}
            onPick={pick} onTransform={onTransform}
            onError={message => { setRenderError(message); setMessage('3D 顯示未完成，已保留上一個成功模型。'); if (lastRendered.current !== currentDisplay.current) setDisplay(lastRendered.current); }} onReady={() => {
            const item = currentDisplay.current;
            if (!item) return;
            const first = lastRendered.current?.lineage !== item.lineage;
            lastRendered.current = item;
            if (item.startedAt !== null) setTiming(performance.now() - item.startedAt);
            if (first) setMessage(item.source === 'demo' ? '示範模型已就緒。可拖曳旋轉、滾輪縮放，點擊零件即可選取。' : '3D 草案已建立。請旋轉檢查主要結構與分件，點擊零件即可選取。');
          }} />
          <div className="stage-label"><span className="tiny-cross">＋</span>{tryingOn ? '護臂試戴' : '虛擬展示位置'}<span>{tryingOn ? '' : 'CONCEPT / 01'}</span></div>
          {!display && !tryingOn && <div className="empty-scene"><div className="reticle"><span /><i /></div><h2>讓第一個想法成形</h2><p>描述物件的外形、顏色與組成，<br />在這裡旋轉檢視立體概念。</p><button className="button ghost" onClick={loadDemo} disabled={agentActive}>載入示範模型</button></div>}
          {display && <div className="model-caption"><span className="eyebrow">{sourceLabel}</span><h2 data-testid="model-name">{display.model.name}</h2><span>{display.model.parts.length} 個實際零件 · 概念草案{single ? ` · 已選取 ${single.name}` : selectedParts.length > 1 ? ` · 已選取 ${selectedParts.length} 個零件` : ''}</span></div>}
          <div className="orientation" aria-hidden="true"><span>Y</span><i />X <b>Z</b></div>
          <div className="stage-footer"><span>拖曳旋轉 · 滾輪縮放 · 點擊選取（Shift 加選）</span><span>未固定於真實桌面</span></div>
        </div>
        <div className="stage-toolbar">
          <div className="button-group">
            <button className="button" onClick={() => camera === 'off' ? void startCamera() : stopCamera()}>{camera === 'off' ? '開啟攝影機' : camera === 'starting' ? '取消開啟' : '關閉攝影機'}</button>
            <button className={`button ${tryingOn ? 'active' : ''}`} type="button" aria-pressed={tryingOn} disabled={(camera === 'starting' && !tryingOn) || agentActive} onClick={toggleTryOn}>
              {tryingOn ? '結束護臂試戴' : '護臂試戴'}
            </button>
            <label className="contrast-toggle"><input type="checkbox" checked={contrast} onChange={e => setContrast(e.target.checked)} />提高背景對比</label>
          </div>
          <div className="button-group"><button className="button" onClick={undo} disabled={!history.past.length || agentActive} title="Ctrl+Z">復原</button><button className="button" onClick={redo} disabled={!history.future.length || agentActive} title="Ctrl+Shift+Z">重做</button><button className="icon-button" onClick={() => sceneRef.current?.zoomOut()} aria-label="縮小" disabled={!display}>−</button><button className="icon-button" onClick={() => sceneRef.current?.zoomIn()} aria-label="放大" disabled={!display}>＋</button><button className="button" onClick={() => sceneRef.current?.reset()} disabled={!display}>重設視角</button></div>
        </div>
        {tryingOn && <p className={`notice ${armTracking.status.endsWith('-error') ? 'warning' : ''}`} role="status" data-testid="try-on-status" data-state={armTracking.status}>{armStatusText[armTracking.status]}
          {armTracking.stats && <span className="small-muted" data-testid="try-on-stats"> · {armTracking.stats.delegate} · 每秒 {armTracking.stats.fps.toFixed(0)} 幀 · 辨識 {armTracking.stats.inferenceMs.toFixed(0)} ms · 偵測到手 {armTracking.stats.handFps.toFixed(0)}／對齊 {armTracking.stats.armFps.toFixed(0)} 次每秒{armTracking.stats.source && ` · 前臂依${armTracking.stats.source === 'elbow' ? '手肘' : '手部方向'}`}</span>}</p>}
        {display && <div className="explode-toolbar"><button type="button" className={`button ${explode > 0 ? 'active' : ''}`} aria-pressed={explode > 0} disabled={agentActive} onClick={() => setExplodeAmount(explode > 0 ? 0 : 1)}>{explode > 0 ? '收回爆炸圖' : '爆炸圖'}</button>
          <label className="explode-slider"><span>拆開程度</span><input type="range" min={0} max={100} step={1} value={Math.round(explode * 100)} aria-label="拆開程度" disabled={agentActive} onChange={event => setExplodeAmount(Number(event.target.value) / 100)} /><output>{Math.round(explode * 100)}%</output></label>
          <span className="small-muted">依零件階層在本機計算，不改模型資料、不呼叫 AI；拆開時停用拖曳把手。</span></div>}
        {cameraError && <p className="notice warning" role="alert">{cameraError}</p>}
        {renderError && <p className="notice warning" role="alert">{renderError}</p>}
        <div className="stage-note"><span className="note-index">01 /</span><p>青藍輪廓呈現零件邊界，琥珀色輪廓表示已選取。攝影機只在本機顯示；生成與修改服務接收你的文字與目前模型資料。</p></div>
      </section>
      <aside className="control-column">
        <AgentPanel agent={agent} disabled={Boolean(busy)} />
        <section className="panel prompt-panel">
          {display && <div className="mode-switch" role="tablist" aria-label="文字用途"><button role="tab" aria-selected={editing} className={editing ? 'active' : ''} onClick={() => setMode('edit')}>修改目前模型</button><button role="tab" aria-selected={!editing} className={!editing ? 'active' : ''} onClick={() => setMode('create')}>生成新物件</button></div>}
          {editing ? <>
            <span className="eyebrow">EDIT THIS CONCEPT</span><h2>想怎麼修改？</h2><p className="muted">只會變更需要改的零件；說「這個」代表已選取的零件。</p>
            <form onSubmit={e => { e.preventDefault(); void edit(); }}><label htmlFor="instruction">修改指示</label><textarea id="instruction" value={instruction} maxLength={4000} disabled={agentActive} onChange={e => setInstruction(e.target.value)} rows={4} placeholder="例如：四條桌腳加長到 50 公分，桌面跟著升高" />
              <div className="input-meta"><span>{selectedParts.length ? `參考已選取：${selectedParts.map(part => part.name).join('、')}` : '未選取零件：套用到整個模型'}</span><span>{instruction.length}/4000</span></div>
              <button className="button primary" type="submit" disabled={!instruction.trim() || agentActive}>套用修改 <span aria-hidden="true">↗</span></button></form>
          </> : <>
            <span className="eyebrow">CREATE A CONCEPT</span><h2>你想建立什麼？</h2><p className="muted">用自己的話描述，不需要固定指令。</p>
            <form onSubmit={e => { e.preventDefault(); void generate(); }}><label htmlFor="prompt">物件描述</label><textarea id="prompt" value={prompt} maxLength={4000} disabled={agentActive} onChange={e => setPrompt(e.target.value)} rows={5} placeholder="例如：一個帶兩個鏡頭、右側裝橘色電池的手持裝置" /><div className="input-meta"><span>形狀 · 色彩 · 件數 · 配置</span><span>{prompt.length}/4000</span></div><button className="button primary" type="submit" disabled={!prompt.trim() || agentActive}>生成 3D 草案 <span aria-hidden="true">↗</span></button></form>
          </>}
          <div className="generation-status" aria-live="polite" role="status"><span className={`status-dot ${busy ? 'pulsing' : ''}`} /><span>{busyText}</span></div>
          {busy && <button className="text-button" onClick={() => { invalidateRequest(); setMessage('已取消等待，目前模型仍可操作。'); }}>{busy === 'edit' ? '取消這次修改' : '取消這次生成'}</button>}
          {error && <div className="notice warning" role="alert"><p>{error}</p><button className="text-button" disabled={agentActive} onClick={() => void (lastFailed.current === 'edit' ? edit() : generate())}>{lastFailed.current === 'edit' ? '重試修改' : '重試生成'}</button></div>}
          {clarify && <div className="notice clarify" data-testid="clarify"><strong>需要確認</strong><p>{clarify}</p><span className="small-muted">補充後再按「套用修改」，目前模型未變更。</span></div>}
          {editSummary && <div className="notice success" data-testid="edit-summary"><strong>已修改：{editSummary.changes}</strong><p>{editSummary.explanation}</p></div>}
          {conflict && <div className="approximation" data-testid="edit-conflict"><h3>修改衝突</h3><p>你在等待期間手動調整了：{conflict.parts.map(part => part.name).join('、')}。AI 的修改是根據調整前的模型產生的。</p><button className="button primary" disabled={agentActive} onClick={() => applyEdit(conflict.result.plan, conflict.result, conflict.startedAt, conflict.lineage)}>套用 AI 修改</button><button className="text-button" disabled={agentActive} onClick={() => { setConflict(null); setMessage('已保留你的手動調整，未套用這次 AI 修改。'); }}>保留手動調整</button></div>}
          {pending && <div className="approximation"><h3>近似方案待確認</h3><p>{pending.result.design.explanation}</p><ul>{pending.result.design.model?.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul><button className="button primary" disabled={agentActive} onClick={() => { applyResult(pending.result, pending.startedAt); setPending(null); }}>接受近似並建立</button><button className="text-button" disabled={agentActive} onClick={() => { setPending(null); setMessage('已取消近似方案，上一個成功模型仍可操作。'); }}>取消近似</button></div>}
          <div className="service-status"><span className={`status-dot ${service?.configured ? 'connected' : 'unavailable'}`} /><div><strong>{service ? providerLabel(service.provider) : '本機服務未連線'}</strong><span>{service?.configured ? service.model : service?.reason || '尚未設定，請依 README 準備登入或金鑰。'}</span></div><button className="text-button" onClick={() => void refreshService()}>重新檢查</button></div><button className="text-button demo-link" onClick={loadDemo} disabled={agentActive}>載入示範模型 <span>非 AI 生成</span></button>
        </section>
        {display && <section className="panel parts-panel" aria-label="零件選取與調整">
          <div className="panel-heading"><span className="eyebrow">SELECT & ADJUST</span><span className="tag">{display.model.parts.length} 件</span></div>
          <h2>零件</h2>
          <ul className="part-picker" aria-label="零件清單">{display.model.parts.map(part => <li key={part.id}><button type="button" aria-pressed={selected.includes(part.id)} disabled={agentActive} className={selected.includes(part.id) ? 'selected' : ''} onClick={event => pick(part.id, event.shiftKey)}>
            <span className="color-chip" style={{ background: part.color }} /><span>{part.name}<small>{part.id}{part.parentId ? ` · 屬於 ${display.model.parts.find(p => p.id === part.parentId)?.name ?? part.parentId}` : ''}</small></span></button></li>)}</ul>
          {!selectedParts.length && <p className="small-muted">點選畫面中的零件或上方清單即可選取；Shift 可多選，Esc 取消選取。</p>}
          {adjustError && <p className="notice warning" role="alert">{adjustError}</p>}
          {single && <div className="part-editor" data-testid="part-editor">
            <div className="editor-row"><label className="text-field"><span>名稱</span><input key={`name-${single.id}-${single.name}`} defaultValue={single.name} aria-label="零件名稱" maxLength={500} disabled={agentActive}
              onBlur={event => { const value = event.target.value.trim(); if (value && value !== single.name) updatePart(single.id, { name: value }); else event.target.value = single.name; }}
              onKeyDown={event => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }} /></label>
              <label className="color-field"><span>顏色</span><input type="color" aria-label="零件顏色" disabled={agentActive} value={single.color.toLowerCase()} onChange={event => updatePart(single.id, { color: event.target.value })} /></label></div>
            <p className="small-muted">{single.primitive} · {single.role === 'interior' ? '內部概念件' : '外部件'} · 位置與角度相對於{single.parentId ? '父零件' : '模型原點'}</p>
            {vector('尺寸', single.dimensions, 'dimensions')}
            {vector('位置', single.position, 'position')}
            {vector('角度', single.rotation, 'rotation')}
            <div className="button-group editor-actions"><button type="button" disabled={explode > 0 || agentActive} className={`button ${transformMode === 'translate' ? 'active' : ''}`} aria-pressed={transformMode === 'translate'} onClick={() => setTransformMode(mode => mode === 'translate' ? null : 'translate')}>拖曳移動</button><button type="button" disabled={explode > 0 || agentActive} className={`button ${transformMode === 'rotate' ? 'active' : ''}`} aria-pressed={transformMode === 'rotate'} onClick={() => setTransformMode(mode => mode === 'rotate' ? null : 'rotate')}>拖曳旋轉</button></div>
            {explode > 0 && <p className="small-muted">爆炸圖開啟中，拖曳把手已停用；收回後即可拖曳。數值欄仍可修改。</p>}
          </div>}
          {selectedParts.length > 0 && <div className="button-group editor-actions"><button type="button" className="button danger" disabled={agentActive} onClick={removeSelected}>刪除{selectedParts.length > 1 ? ` ${selectedParts.length} 個` : ''}零件</button><button type="button" className="text-button" disabled={agentActive} onClick={() => { setSelected([]); setTransformMode(null); }}>取消選取</button></div>}
        </section>}
        <section className="panel details-panel"><div className="panel-heading"><span className="eyebrow">MODEL DETAILS</span><span className="tag">概念階段</span></div><h2>模型與假設</h2>{display ? <><p className="model-summary">{display.model.summary}</p><dl className="model-meta"><div><dt>來源</dt><dd>{sourceLabel}</dd></div><div><dt>生成模型</dt><dd>{display.providerModel}</dd></div><div><dt>資料版本 / 單位</dt><dd>{display.model.schemaVersion} / m（公尺）</dd></div>{timing !== null && <div><dt>送出至繪製提交</dt><dd>{(timing / 1000).toFixed(2)} 秒</dd></div>}</dl>{timing !== null && <p className="small-muted">本機觀測時間，含生成與繪製提交；尚非辨識品質或 GPU 完成量測。</p>}<h3>暫定假設</h3><ul className="assumptions">{display.model.assumptions.length ? display.model.assumptions.map((a, i) => <li key={i}>{a}</li>) : <li>未另列假設；概念尺寸仍需核對。</li>}</ul><details><summary>已建立零件（{display.model.parts.length}）</summary><ul className="parts-list">{display.model.parts.map(part => <li key={part.id}><span className="color-chip" style={{ background: part.color }} /><span>{part.name}<small>{part.id} · {part.role === 'interior' ? '內部概念件' : '外部件'}<br />{[part.dimensions.x, part.dimensions.y, part.dimensions.z].map(v => Number((v * 1000).toFixed(2))).join(' × ')} mm</small></span></li>)}</ul></details></> : <p className="empty-details">生成後會在這裡列出來源、實際零件與尺寸假設。<br />細節不足時，模型會清楚標示暫定配置。</p>}</section>
      </aside>
    </main>
    <footer className="app-footer"><span>FORGEHAND</span><span>概念視覺化 · 非工程量測或製造驗證</span></footer>
  </div>;
}
