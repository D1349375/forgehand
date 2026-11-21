import { useEffect, useMemo, useRef, useState } from 'react';
import type { BufferGeometry } from 'three';
import { assemblyOf } from '../shared/assembly';
import { realignJoint } from '../shared/contact';
import { demoModel } from '../shared/demo';
import { applyEditPlan, describeChanges, editConflicts, EditError, EditResultSchema, validateEditPlan, type EditPlan, type EditResult } from '../shared/edit';
import { newJoint, recommendJoint } from '../shared/joint-rules';
import type { Joint } from '../shared/joint';
import type { MaterialId } from '../shared/materials';
import { validateGenerationResult, validateModel, type GenerationResult, type ModelSpec, type Part } from '../shared/model';
import type { PrinterProfile } from '../shared/printer';
import {
  MAX_OBJECTS, WorkspaceError, activeObject, addObject, createObject, emptyWorkspace, findObject, joinObjects, jointsRemovedBy, removeJoint, removeObject, replaceModel,
  selectParts, setActiveObject, setExplode as setWorkspaceExplode, setMaterial, setTransform, updateJoint, type ObjectTransform, type SceneObject, type Workspace,
} from '../shared/workspace';
import { SceneViewport, type JoinPreview, type SceneHandle, type TransformMode, type Vector } from './scene/SceneViewport';
import { computeMarks, glowMarks } from './scene/joint-marks';
import { JointCard, type PrintPreviewState } from './joints/JointCard';
import { JointPanel } from './joints/JointPanel';
import { PrinterPanel } from './joints/PrinterPanel';
import {
  buildKit, jointCardModel, jointRows, jointSideNames, onConfirm, onMethod, onNeeds, onParam, onRecommendation, type JointPatch,
} from './joints/card-model';
import { JOINT_NOTICES } from './joints/labels';
import { mouseJoinStep, previewPoses, type MouseJoinEvent, type MouseJoinState } from './joints/mouse-join';
import { loadPrinterProfile, savePrinterProfile } from './joints/printer-store';
import { useArmTracking, type ArmTrackingStatus } from './try-on/useArmTracking';
import { HandOverlay, type HandOverlayHandle } from './hands/HandOverlay';
import { handGate, initialSpeedState, parseLossMs, parseMinFps, speedStep, type SpeedState } from './hands/gate';
import { HandDebugPanel, handDebugRequested } from './hands/HandDebugPanel';
import { useHandControl } from './hands/useHandControl';
import { useHandTracking } from './hands/useHandTracking';
import type { AgentTurn } from '../shared/agent';
import { AgentPanel } from './agent/AgentPanel';
import { HISTORY_TURN_LIMIT } from './agent/request';
import type { StateEffects } from './agent/apply-state';
import { useAgentRun } from './agent/useAgentRun';
import { NumberField } from './ui/NumberField';
import { canApplyEdit, pickPart } from './workspace/app-rules';
import { ObjectPanel } from './workspace/ObjectPanel';
import { renameObject } from './workspace/object-panel';
import { useWorkspace } from './workspace/useWorkspace';

type ServiceStatus = { configured: boolean; provider: string; model: string; reason?: string };
const providerLabel = (provider?: string) => provider === 'codex' ? 'Codex CLI' : provider === 'claude' ? 'Claude Code CLI' : 'OpenAI API';
type Pending = { result: GenerationResult; startedAt: number };
/** `objectId` is the object the AI answer was made for; undo/redo may leave it while the dialog is open. */
type Conflict = { result: EditResult; parts: Part[]; startedAt: number; objectId: string };
type Busy = null | 'generate' | 'edit';
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

/** `localStorage`, or `null` where the browser refuses access (the printer setting then lasts for the session). */
function browserStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** The notice suffix of a change that also removed joints (a deleted object, a part or face that is gone). */
function cascadeNotice(before: Workspace, after: Workspace): string {
  const removed = jointsRemovedBy(before, after);
  return removed > 0 ? JOINT_NOTICES.cascade(removed) : '';
}

export default function App() {
  const [prompt, setPrompt] = useState('一個紅色、有四條腿的小桌子');
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<'edit' | 'create'>('create');
  const [service, setService] = useState<ServiceStatus | null>(null);
  const store = useWorkspace();
  const { workspace } = store;
  const active = activeObject(workspace);
  const selected = workspace.selection.partIds;
  /** Exploded-view amount (0–1). Display state only: part of the workspace, never an undo step. */
  const explode = workspace.display.explode;
  const atLimit = workspace.objects.length >= MAX_OBJECTS;
  const [transformMode, setTransformMode] = useState<TransformMode>(null);
  /** The printer's tolerances: a browser setting, not part of the workspace and never an undo step. */
  const [printer, setPrinter] = useState(() => loadPrinterProfile(browserStorage()));
  /** 顯示接合: session state. */
  const [showJoints, setShowJoints] = useState(true);
  const [openJointId, setOpenJointId] = useState<string | null>(null);
  const [mouseJoin, setMouseJoin] = useState<MouseJoinState>({ step: 'off' });
  /** The mouse join as the click handlers see it: updated in the same call as the state, so two quick clicks never read a stale step. */
  const mouseJoinRef = useRef<MouseJoinState>({ step: 'off' });
  const [mouseNotice, setMouseNotice] = useState('');
  /** A rejected joint change: shown in the 接合 panel, or in the card for a card action. */
  const [jointError, setJointError] = useState('');
  const [cardError, setCardError] = useState('');
  const [printPreview, setPrintPreview] = useState<{ objectId: string; partId: string; status: 'loading' | 'ready'; geometry: BufferGeometry | null } | null>(null);
  /** Each print preview request takes a number; an answer that arrives after the preview was closed or replaced is dropped. */
  const printPreviewRequest = useRef(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [message, setMessage] = useState('先開啟攝影機，再描述你想看見的物件。');
  const [error, setError] = useState('');
  const [clarify, setClarify] = useState('');
  const [editSummary, setEditSummary] = useState<{ changes: string; explanation: string } | null>(null);
  const [adjustError, setAdjustError] = useState('');
  /** A rejected 物件 panel change (a bad name), shown inside that panel. */
  const [objectError, setObjectError] = useState('');
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
  /** 手勢: hand control is on by default whenever the camera is on. */
  const [handsOn, setHandsOn] = useState(true);
  /** 隱藏鏡頭畫面: the video keeps playing and tracking continues, only the image is not shown. Session state. */
  const [cameraHidden, setCameraHidden] = useState(false);
  /** Hand tracking too slow for gestures (requirement 40), from the measured rate. */
  const [slow, setSlow] = useState(false);
  const speed = useRef<SpeedState>(initialSpeedState());
  /** Speed threshold: MIN_CONTROL_FPS, or ?hands-min-fps=<number> for slow machines. Read once at load. */
  const [minFps] = useState(() => parseMinFps(window.location.search));
  const [lossMs] = useState(() => parseLossMs(window.location.search));
  const tracking = useHandTracking(videoRef, {
    running: camera === 'on', needed: handsOn || tryOnActive, wantPose: tryOnActive, mirrored,
    onRate: (fps, now) => {
      speed.current = speedStep(speed.current, fps, now, minFps);
      setSlow(speed.current.slow);
    },
  });
  const armTracking = useArmTracking(tracking.source, tracking.status, tryOnActive);
  const overlayRef = useRef<HandOverlayHandle>(null);
  const handControlOn = camera === 'on' && handsOn;
  const sceneRef = useRef<SceneHandle>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraRequest = useRef(0);
  const latest = useRef(0);
  const requestStarted = useRef(0);
  const controller = useRef<AbortController | null>(null);
  /** The workspace as of the last completed render; the fallback when a later build fails. */
  const lastRendered = useRef<Workspace | null>(null);
  /** When the request behind the latest generate, edit or agent commit started, for the active object's render time. */
  const timingRef = useRef<{ objectId: string; startedAt: number } | null>(null);
  const lastFailed = useRef<'generate' | 'edit'>('generate');
  /** The latest completed agent turns, newest last, sent as history so follow-ups have context. */
  const agentTurns = useRef<AgentTurn[]>([]);
  const agent = useAgentRun({
    applyWorkspace: applyAgentWorkspace,
    setTryingOn,
    getSnapshot: () => ({ workspace: store.current(), tryOn: tryingOn, cameraOn: camera === 'on' }),
    getTurns: () => agentTurns.current,
    pushTurn: turn => { agentTurns.current = [...agentTurns.current, turn].slice(-HISTORY_TURN_LIMIT); },
  });
  /** While an agent run is active the user can only watch or cancel: manual changes would race its edits. */
  const agentActive = agent.active;
  const gate = handGate({ tryOn: tryOnActive, slow, agentActive, exploded: explode > 0 });
  const handControl = useHandControl({
    source: tracking.source, tracker: tracking.status, enabled: handControlOn, gate, videoRef, overlayRef,
    objectCount: workspace.objects.length, sceneRef, lossMs, onPick: (objectId, partId) => pick(objectId, partId, false),
  });
  const handDebug = handDebugRequested(window.location.search);

  // Joints (assembly-joints). Everything shown is derived: checks, features and findings come from the workspace and the printer profile.
  /** Recomputed only when the objects, the joints or the printer profile change. */
  const kit = useMemo(() => buildKit(workspace, printer), [workspace.objects, workspace.joints, printer]);
  /** The joint whose card is open; a card whose joint is gone closes. */
  const cardJointId = openJointId && workspace.joints.some(joint => joint.id === openJointId) ? openJointId : null;
  const jointRowList = useMemo(() => jointRows(workspace, kit.findings), [workspace.objects, workspace.joints, kit]);
  const recommendations = useMemo(() => cardJointId ? recommendJoint(workspace, cardJointId, printer) : [], [workspace.objects, workspace.joints, printer, cardJointId]);
  const cardModel = useMemo(() => cardJointId ? jointCardModel(workspace, cardJointId, kit, recommendations) : null, [workspace.objects, workspace.joints, kit, recommendations, cardJointId]);
  const marks = useMemo(() => computeMarks(workspace, kit, cardJointId), [workspace.objects, workspace.joints, kit, cardJointId]);
  /** While a mouse join shows its preview: side b's assembly at the aligned pose, the two faces glowing and the 可以接合 cue. */
  const joinPreview = useMemo<JoinPreview | null>(() => {
    if (mouseJoin.step !== 'preview') return null;
    const poses = previewPoses(workspace, mouseJoin.plan);
    if (!poses) return null;
    return { transforms: poses.transforms, glow: glowMarks(workspace, mouseJoin.plan.a, mouseJoin.plan.b), label: poses.label, ready: true };
  }, [mouseJoin, workspace.objects, workspace.joints]);
  const printPreviewProp = useMemo(
    () => printPreview?.status === 'ready' && printPreview.geometry ? { objectId: printPreview.objectId, partId: printPreview.partId, geometry: printPreview.geometry } : null,
    [printPreview]);

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

  // Keep the render-error fallback in step with changes that never rebuild geometry (object transform, active object,
  // selection, explode, removing an object). A workspace whose objects all have the model reference the scene last built
  // is already what the scene shows, so it becomes the fallback. Anything that needs a build waits for `onReady`.
  useEffect(() => {
    const last = lastRendered.current;
    if (!last || last === workspace) return;
    const built = new Map(last.objects.map(object => [object.id, object.model]));
    if (workspace.objects.every(object => built.get(object.id) === object.model)) lastRendered.current = workspace;
  }, [workspace]);

  // Another object becoming active ends any drag mode that belonged to the old one.
  useEffect(() => { setTransformMode(null); }, [workspace.activeObjectId]);

  /** Adds a new object and makes it active. An undo step, except the very first object. Returns false (with a notice) when it cannot be added. */
  function addNewObject(input: { id?: string; model: unknown; source: string; providerModel: string; startedAt: number | null }): boolean {
    const before = store.current();
    try {
      const object = createObject(before, { id: input.id ?? crypto.randomUUID(), model: input.model, source: input.source, providerModel: input.providerModel, createdAt: new Date().toISOString() });
      store.dispatch({ type: 'commit', next: addObject(before, object) });
      timingRef.current = input.startedAt === null ? null : { objectId: object.id, startedAt: input.startedAt };
      return true;
    } catch (cause) {
      setError(cause instanceof WorkspaceError ? cause.message : '無法加入這個物件，目前工作區未變更。');
      setMessage('目前工作區未新增物件，現有物件仍可操作。');
      return false;
    }
  }
  /** After undo or redo: drop notices about the change that was just reverted. */
  function afterRestore(before: Workspace, after: Workspace, label: string) {
    if (after.selection.partIds.length !== before.selection.partIds.length) setTransformMode(null);
    timingRef.current = null;
    setTiming(null); setAdjustError(''); setEditSummary(null);
    setMessage(label);
  }
  function undo() {
    if (agentActive) return;
    const before = store.current();
    const after = store.dispatch({ type: 'undo' });
    if (after !== before) afterRestore(before, after, '已復原上一步。');
  }
  function redo() {
    if (agentActive) return;
    const before = store.current();
    const after = store.dispatch({ type: 'redo' });
    if (after !== before) afterRestore(before, after, '已重做。');
  }
  /** Selection is not an undo step. Selects `ids` in the active object; unknown ids are ignored. */
  function selectInActive(ids: string[]) {
    const before = store.current();
    const object = activeObject(before);
    if (!object) return;
    const known = new Set(object.model.parts.map(part => part.id));
    const next = selectParts(before, object.id, [...new Set(ids)].filter(id => known.has(id)));
    store.dispatch({ type: 'replace', next });
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
      setHandsOn(true);
      resetCameraSession();
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
    setHandsOn(true);
    resetCameraSession();
  }
  /** Session state that only lives while the camera is on. */
  function resetCameraSession() {
    setCameraHidden(false);
    speed.current = initialSpeedState();
    setSlow(false);
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
    if (!addNewObject({ model: result.design.model, source: result.source, providerModel: result.model, startedAt })) return;
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
      const hasObjects = store.current().objects.length > 0;
      const retained = hasObjects ? (kind === 'edit' ? '目前模型未變更。' : '已保留上一個成功模型。') : '目前尚未建立模型。';
      setError(abort.signal.aborted ? `這次${kind === 'edit' ? '修改' : '生成'}已逾時，${retained}可重試或簡化描述。`
        : cause instanceof SyntaxError ? `模型服務回覆資料無法讀取，${retained}請重試。`
        : cause instanceof TypeError ? `無法連線到本機模型服務，${retained}請確認工作台仍在執行後重試。`
        : cause instanceof Error ? cause.message : '請求失敗，請重試。');
      setMessage(hasObjects ? `${kind === 'edit' ? '修改' : '生成'}未完成，目前模型仍可操作。` : '生成未完成，目前尚未建立模型。');
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

  function applyEdit(plan: EditPlan, result: EditResult, startedAt: number, objectId: string) {
    const before = store.current();
    const check = canApplyEdit(before, objectId, 'conflict');
    const target = check.ok ? findObject(before, objectId) : null;
    if (!check.ok || !target) {
      setConflict(null);
      setError(check.ok ? '' : check.message);
      setMessage('修改未套用，目前模型仍可操作。');
      return;
    }
    try {
      const { model, changes } = applyEditPlan(target.model, plan);
      setRenderError(''); setTiming(null); setConflict(null);
      const edited = replaceModel(before, target.id, model, { source: result.source, providerModel: result.model });
      store.dispatch({ type: 'commit', next: selectParts(edited, target.id, [...changes.added, ...changes.updated]), before });
      timingRef.current = { objectId: target.id, startedAt };
      setEditSummary({ changes: describeChanges(target.model, model, changes), explanation: plan.explanation });
      setInstruction('');
      setMessage(`修改已套用，可按「復原」回到上一步。${cascadeNotice(before, edited)}`);
    } catch (cause) {
      setConflict(null);
      setError(`${cause instanceof EditError ? cause.message : '修改無法套用。'}目前模型未變更。`);
      setMessage('修改未套用，目前模型仍可操作。');
    }
  }

  async function edit() {
    if (agentActive) return;
    const base = activeObject(store.current());
    if (!base) { setError('請先生成或載入一個模型。'); return; }
    if (!instruction.trim()) { setError('請輸入想怎麼修改目前模型。'); return; }
    const selection = store.current().selection.partIds.filter(id => base.model.parts.some(part => part.id === id));
    await callModel('edit', '/api/edit', { instruction: instruction.trim(), model: base.model, selectedPartIds: selection }, (body, requestId, startedAt) => {
      let result: EditResult;
      try { result = EditResultSchema.parse(body) as EditResult; result.plan = validateEditPlan(result.plan); }
      catch { throw new Error('模型服務返回無效的修改資料，目前模型未變更。請重試或換個說法。'); }
      if (result.requestId !== requestId) throw new Error('模型回應與目前請求不符，目前模型未變更。');
      setService({ configured: true, provider: result.source, model: result.model });
      const { plan } = result;
      if (plan.status === 'clarify') { setClarify(plan.explanation); setMessage('需要你補充一點資訊，目前模型未變更。'); return; }
      if (plan.status === 'unsupported') { setError(plan.explanation); setMessage('這次修改無法處理，目前模型未變更。'); return; }
      const check = canApplyEdit(store.current(), base.id, 'answer');
      const current = check.ok ? findObject(store.current(), base.id) : null;
      if (!check.ok || !current) {
        setError(check.ok ? '' : check.message); setMessage('修改未套用，目前模型仍可操作。'); return;
      }
      const parts = editConflicts(base.model, current.model, plan);
      if (parts.length) { setConflict({ result, parts, startedAt, objectId: base.id }); setMessage('AI 修改與你剛才的手動調整有衝突，請選擇要保留哪一個。'); return; }
      applyEdit(plan, result, startedAt, base.id);
    });
  }

  function loadDemo() {
    if (agentActive) return;
    invalidateRequest(); setError(''); setRenderError(''); setTiming(null); setEditSummary(null); setClarify('');
    if (!addNewObject({ model: demoModel, source: 'demo', providerModel: '本機示範資料', startedAt: null })) return;
    setMode('edit');
    setMessage('已載入預先建立的示範模型，這不是 AI 生成結果。');
  }

  /**
   * One `state` event from the agent. An object change is an undo step (`commit` with the workspace after activation as `before`)
   * and drops dialogs and notices that belonged to the old model, like applyResult/applyEdit; selection, explode and
   * activation alone are not undo steps. The server built the whole change: nothing is created here.
   */
  function applyAgentWorkspace({ before, after, recordUndo }: StateEffects) {
    if (!recordUndo) {
      store.dispatch({ type: 'replace', next: after });
      if (after.display.explode > 0) setTransformMode(null);
      return;
    }
    setPending(null); setConflict(null); setEditSummary(null); setClarify('');
    setTiming(null); setRenderError('');
    store.dispatch({ type: 'commit', next: after, before });
    // The object whose model was added or replaced is the one whose render time is shown.
    const previous = new Map(before.objects.map(object => [object.id, object.model]));
    const built = after.objects.find(object => previous.get(object.id) !== object.model);
    timingRef.current = built ? { objectId: built.id, startedAt: performance.now() } : null;
    if (after.display.explode > 0) setTransformMode(null);
    if (after.objects.length > before.objects.length) { setMode('edit'); setMessage('代理已建立新物件，可按「復原」回到上一步。'); }
    else if (after.objects.length < before.objects.length) setMessage('代理已刪除物件，可按「復原」回到上一步。');
    else if (built) setMessage('代理已修改物件，可按「復原」回到上一步。');
    else setMessage('代理已調整物件位置，可按「復原」回到上一步。');
  }
  /** Local, immediate change; validated exactly like AI output before display. */
  function adjust(next: ModelSpec, label: string): boolean {
    const before = store.current();
    const current = activeObject(before);
    if (!current) return false;
    try {
      const model = validateModel(next);
      const after = replaceModel(before, current.id, model);
      setAdjustError(''); setEditSummary(null); setTiming(null); setRenderError('');
      timingRef.current = null;
      store.dispatch({ type: 'commit', next: after });
      setMessage(label + cascadeNotice(before, after));
      return true;
    } catch (cause) {
      setAdjustError(`這個調整未通過資料驗證，未套用。${cause instanceof Error ? cause.message.slice(0, 120) : ''}`);
      return false;
    }
  }
  function updatePart(id: string, patch: Partial<Part>, label = '已調整零件，可按「復原」回到上一步。') {
    if (agentActive) return;
    const current = activeObject(store.current());
    if (!current) return;
    adjust({ ...current.model, parts: current.model.parts.map(part => part.id === id ? { ...part, ...patch } : part) }, label);
  }
  function removeSelected() {
    if (agentActive) return;
    const current = activeObject(store.current());
    if (!current || !selected.length) return;
    const removing = new Set(selected);
    const child = current.model.parts.find(part => part.parentId && removing.has(part.parentId) && !removing.has(part.id));
    if (child) { setAdjustError(`「${child.name}」仍依附在要刪除的零件上，請先刪除或調整子零件。`); return; }
    if (removing.size >= current.model.parts.length) { setAdjustError('模型至少需要保留一個零件。'); return; }
    // replaceModel drops the removed parts from the selection.
    if (adjust({ ...current.model, parts: current.model.parts.filter(part => !removing.has(part.id)) }, `已刪除 ${selected.length} 個零件，可按「復原」回到上一步。`)) setTransformMode(null);
  }
  function pick(objectId: string | null, id: string | null, additive: boolean) {
    if (agentActive) return;
    // During a mouse join a click chooses a part for the join instead of selecting it (the part list and hand pinches too).
    if (mouseJoinRef.current.step !== 'off') { stepMouseJoin({ type: 'pick', objectId, partId: id }); return; }
    setAdjustError('');
    const before = store.current();
    const next = pickPart(before, objectId, id, additive);
    if (next !== before) store.dispatch({ type: 'replace', next });
  }
  /** 物件 panel changes. Switching is not an undo step; rename, move and delete are one each. */
  function activateObject(id: string) {
    if (agentActive) return;
    setObjectError(''); setAdjustError('');
    const before = store.current();
    try {
      const next = setActiveObject(before, id);
      if (next !== before) store.dispatch({ type: 'replace', next });
    } catch { setObjectError('找不到這個物件，工作區未變更。'); }
  }
  function commitObjectChange(change: (before: Workspace) => Workspace, label: string) {
    if (agentActive) return;
    const before = store.current();
    try {
      const next = change(before);
      setObjectError('');
      if (next === before) return;
      setEditSummary(null); setAdjustError('');
      store.dispatch({ type: 'commit', next });
      setMessage(label + cascadeNotice(before, next));
    } catch (cause) {
      setObjectError(cause instanceof WorkspaceError ? '這個物件調整未通過驗證，未套用。' : cause instanceof Error ? cause.message : '物件調整失敗，未套用。');
    }
  }
  const renameObjectTo = (id: string, text: string) => commitObjectChange(ws => renameObject(ws, id, text), '已重新命名物件，可按「復原」回到上一步。');
  /** An object that is joined to others moves with its whole assembly (one undo step); the notice says how many others moved. */
  const moveObject = (id: string, patch: { position?: ObjectTransform['position']; rotation?: ObjectTransform['rotation'] }) => {
    const others = assemblyOf(store.current(), id).length - 1;
    commitObjectChange(ws => setTransform(ws, id, patch), others > 0 ? JOINT_NOTICES.assemblyMoved(others) : '已調整物件位置，可按「復原」回到上一步。');
  };
  const deleteObject = (id: string) => commitObjectChange(ws => removeObject(ws, id), '已刪除物件，可按「復原」回到上一步。');
  function setExplodeAmount(amount: number) {
    const before = store.current();
    if (before.objects.length > 0) store.dispatch({ type: 'replace', next: setWorkspaceExplode(before, amount) });
    if (amount > 0) setTransformMode(null);
  }
  /** The gizmo and a hand grab share this path: one commit, one undo step. */
  function onTransform(objectId: string, id: string, position: Vector, rotation: Vector, kind: 'translate' | 'rotate') {
    if (agentActive || objectId !== store.current().activeObjectId) return;
    updatePart(id, { position, rotation }, kind === 'rotate' ? '已旋轉零件，可按「復原」回到上一步。' : '已移動零件，可按「復原」回到上一步。');
  }

  // ---- Joints: mouse join, joint changes, material, printer profile and print preview ----
  useEffect(() => { if (openJointId && !cardJointId) setOpenJointId(null); }, [openJointId, cardJointId]);
  // Any other change of the workspace (an undo step, undo, redo) or of the printer profile ends a mouse join and closes a print preview.
  useEffect(() => {
    stepMouseJoin({ type: 'workspace-changed' });
    closePrintPreview();
    setJointError(''); setCardError('');
  }, [workspace.objects, workspace.joints, printer]);
  // An agent run starting cancels the mouse join.
  useEffect(() => { if (agentActive) stepMouseJoin({ type: 'cancel' }); }, [agentActive]);

  function stepMouseJoin(event: MouseJoinEvent) {
    const result = mouseJoinStep(mouseJoinRef.current, event, store.current());
    if (result.state !== mouseJoinRef.current) { mouseJoinRef.current = result.state; setMouseJoin(result.state); }
    setMouseNotice(result.notice ?? '');
  }
  function startMouseJoin() {
    if (agentActive) return;
    setTransformMode(null); setJointError(''); setCardError('');
    stepMouseJoin({ type: 'start' });
  }
  /** 確認接合: the aligned move and the new joint in one result, so one undo step; the card opens. */
  function confirmMouseJoin() {
    const state = mouseJoinRef.current;
    if (state.step !== 'preview' || agentActive) return;
    const before = store.current();
    try {
      const moves = state.plan.move ? [state.plan.move] : [];
      const moved = moves.reduce((ws, move) => setTransform(ws, move.objectId, move.transform), before);
      const joint = newJoint(moved, { id: crypto.randomUUID(), createdAt: new Date().toISOString(), a: state.plan.a, b: state.plan.b }, printer);
      const next = joinObjects(before, { moves, joint });
      setEditSummary(null); setAdjustError(''); setJointError(''); setCardError('');
      mouseJoinRef.current = { step: 'off' }; setMouseJoin({ step: 'off' }); setMouseNotice('');
      store.dispatch({ type: 'commit', next });
      setOpenJointId(joint.id);
      const names = jointSideNames(next, joint);
      setMessage(JOINT_NOTICES.joined(names.a, names.b));
    } catch (cause) {
      setJointError(cause instanceof WorkspaceError ? cause.message : JOINT_NOTICES.rejected);
    }
  }
  /** One joint change: one commit and a notice, with the cascade suffix when it removed joints. A rejected change is reported through `report`. */
  function commitJointChange(change: (before: Workspace) => Workspace, label: string, report: (message: string) => void): boolean {
    if (agentActive) return false;
    const before = store.current();
    try {
      const next = change(before);
      report('');
      if (next === before) return false;
      setEditSummary(null); setAdjustError('');
      store.dispatch({ type: 'commit', next });
      setMessage(label + cascadeNotice(before, next));
      return true;
    } catch (cause) {
      report(cause instanceof WorkspaceError ? cause.message : JOINT_NOTICES.rejected);
      return false;
    }
  }
  function changeJoint(id: string, patchFor: (ws: Workspace, joint: Joint) => JointPatch, label: string) {
    commitJointChange(ws => {
      const joint = ws.joints.find(candidate => candidate.id === id);
      if (!joint) throw new WorkspaceError('UNKNOWN_JOINT');
      return updateJoint(ws, id, patchFor(ws, joint));
    }, label, setCardError);
  }
  function removeJointById(id: string) {
    if (commitJointChange(ws => removeJoint(ws, id), JOINT_NOTICES.removed, setCardError)) setOpenJointId(null);
  }
  const setObjectMaterial = (id: string, material: MaterialId | null) => commitObjectChange(ws => setMaterial(ws, id, material), JOINT_NOTICES.material);
  function changePrinter(next: PrinterProfile) {
    setPrinter(next);
    savePrinterProfile(browserStorage(), next);
  }
  function closePrintPreview() {
    printPreviewRequest.current++;
    setPrintPreview(null);
  }
  /** 預覽「…」列印件: builds the printable solid of one part on demand (the CSG library loads on first use). A second press closes it. */
  async function togglePrintPreview(target: { objectId: string; partId: string }) {
    if (printPreview?.objectId === target.objectId && printPreview.partId === target.partId) { closePrintPreview(); return; }
    const request = ++printPreviewRequest.current;
    setPrintPreview({ ...target, status: 'loading', geometry: null });
    try {
      const ws = store.current();
      const part = findObject(ws, target.objectId)?.model.parts.find(candidate => candidate.id === target.partId);
      if (!part) throw new Error('missing part');
      const current = buildKit(ws, printer);
      const features = current.features.parts.get(`${target.objectId}:${target.partId}`) ?? [];
      // Features of a joint with an error are left out of the preview, like they will be in the export.
      const skip = new Set(features.filter(feature => current.findings.get(feature.jointId)?.some(finding => finding.severity === 'error')).map(feature => feature.id));
      const { printablePart, toBufferGeometry } = await import('./print/printable');
      const result = await printablePart(part, features, { skip });
      if (request !== printPreviewRequest.current) return;
      setPrintPreview({ ...target, status: 'ready', geometry: toBufferGeometry(result.mesh) });
    } catch {
      if (request !== printPreviewRequest.current) return;
      setPrintPreview(null);
      setCardError(JOINT_NOTICES.previewFailed);
    }
  }
  const previewState: PrintPreviewState | null = printPreview ? { objectId: printPreview.objectId, partId: printPreview.partId, status: printPreview.status } : null;

  // Keyboard shortcuts never fire while typing in a field.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (agentActive) return; // undo, redo, Escape and Delete all change the model or selection
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); redo(); }
      else if (event.key === 'Escape') {
        // Esc first puts a running mouse join away; only then does it clear the selection.
        if (mouseJoinRef.current.step !== 'off') stepMouseJoin({ type: 'cancel' });
        else { selectInActive([]); setTransformMode(null); }
      }
      else if (event.key === 'Delete' && selected.length) { event.preventDefault(); removeSelected(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const editing = mode === 'edit' && Boolean(active);
  const selectedParts = active ? selected.map(id => active.model.parts.find(part => part.id === id)).filter((part): part is Part => Boolean(part)) : [];
  const single = selectedParts.length === 1 ? selectedParts[0]! : null;
  const sourceBase = active?.source === 'demo' ? '示範資料 · 非 AI 生成' : `${providerLabel(active?.source)} 生成`;
  const sourceLabel = active?.edited ? `${sourceBase} · 已修改` : sourceBase;
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
          <video ref={videoRef} muted playsInline autoPlay className={`camera-video ${camera === 'on' && !cameraHidden ? 'visible' : ''} ${mirrored ? 'mirrored' : ''}`} data-mirrored={mirrored} data-image-hidden={cameraHidden} aria-label="即時攝影機背景" />
          <div className="viewport-shade" />
          <SceneViewport ref={sceneRef} objects={workspace.objects} activeObjectId={workspace.activeObjectId} selectedIds={selected} transformMode={agentActive || mouseJoin.step !== 'off' ? null : transformMode} explode={explode}
            joints={workspace.joints} marks={marks} showJoints={showJoints} joinPreview={joinPreview} printPreview={printPreviewProp}
            tryOn={tryOnActive ? armTracking.sample : undefined}
            onPick={pick} onTransform={onTransform}
            onError={message => {
              setRenderError(message); setMessage('3D 顯示未完成，已保留上一個成功模型。');
              // Fall back to the last workspace that rendered (an empty one if nothing did yet).
              const fallback = lastRendered.current ?? (store.current().objects.length ? emptyWorkspace() : null);
              if (fallback && fallback !== store.current()) store.dispatch({ type: 'replace', next: fallback });
            }} onReady={() => {
            const now = store.current();
            const item = activeObject(now);
            if (!item) return;
            const first = lastRendered.current?.activeObjectId !== item.id;
            lastRendered.current = now;
            const timed = timingRef.current;
            if (timed && timed.objectId === item.id) { setTiming(performance.now() - timed.startedAt); timingRef.current = null; }
            if (first) setMessage(item.source === 'demo' ? '示範模型已就緒。可拖曳旋轉、滾輪縮放，點擊零件即可選取。' : '3D 草案已建立。請旋轉檢查主要結構與分件，點擊零件即可選取。');
          }} />
          {handControlOn && <HandOverlay ref={overlayRef} />}
          <div className="stage-label"><span className="tiny-cross">＋</span>{tryingOn ? '護臂試戴' : '虛擬展示位置'}<span>{tryingOn ? '' : 'CONCEPT / 01'}</span></div>
          {!active && !tryingOn && <div className="empty-scene"><div className="reticle"><span /><i /></div><h2>讓第一個想法成形</h2><p>描述物件的外形、顏色與組成，<br />在這裡旋轉檢視立體概念。</p><button className="button ghost" onClick={loadDemo} disabled={agentActive || atLimit}>載入示範模型</button></div>}
          {active && <div className="model-caption"><span className="eyebrow">{sourceLabel}</span><h2 data-testid="model-name">{active.model.name}</h2><span>{active.model.parts.length} 個實際零件 · 概念草案{single ? ` · 已選取 ${single.name}` : selectedParts.length > 1 ? ` · 已選取 ${selectedParts.length} 個零件` : ''}{workspace.objects.length > 1 ? ` · 工作區 ${workspace.objects.length} 個物件` : ''}</span></div>}
          <div className="orientation" aria-hidden="true"><span>Y</span><i />X <b>Z</b></div>
          <div className="stage-footer"><span>拖曳旋轉 · 滾輪縮放 · 點擊選取（Shift 加選）</span><span>未固定於真實桌面</span></div>
        </div>
        <div className="stage-toolbar">
          <div className="button-group">
            <button className="button" onClick={() => camera === 'off' ? void startCamera() : stopCamera()}>{camera === 'off' ? '開啟攝影機' : camera === 'starting' ? '取消開啟' : '關閉攝影機'}</button>
            <button className={`button ${tryingOn ? 'active' : ''}`} type="button" aria-pressed={tryingOn} disabled={(camera === 'starting' && !tryingOn) || agentActive} onClick={toggleTryOn}>
              {tryingOn ? '結束護臂試戴' : '護臂試戴'}
            </button>
            {camera === 'on' && <button className={`button ${handsOn ? 'active' : ''}`} type="button" aria-pressed={handsOn} onClick={() => setHandsOn(on => !on)}>手勢</button>}
            {camera === 'on' && <button className={`button ${cameraHidden ? 'active' : ''}`} type="button" aria-pressed={cameraHidden} onClick={() => setCameraHidden(hidden => !hidden)}>隱藏鏡頭畫面</button>}
            <label className="contrast-toggle"><input type="checkbox" checked={contrast} onChange={e => setContrast(e.target.checked)} />提高背景對比</label>
          </div>
          <div className="button-group"><button className="button" onClick={undo} disabled={!store.canUndo || agentActive} title="Ctrl+Z">復原</button><button className="button" onClick={redo} disabled={!store.canRedo || agentActive} title="Ctrl+Shift+Z">重做</button><button className="icon-button" onClick={() => sceneRef.current?.zoomOut()} aria-label="縮小" disabled={!active}>−</button><button className="icon-button" onClick={() => sceneRef.current?.zoomIn()} aria-label="放大" disabled={!active}>＋</button><button className="button" onClick={() => sceneRef.current?.reset()} disabled={!active}>重設視角</button></div>
        </div>
        {handControlOn && handControl.status.state !== 'hidden' && <p className={`notice hand-status ${['error', 'slow'].includes(handControl.status.state) ? 'warning' : ''}`} role="status" data-testid="hand-status" data-state={handControl.status.state}>{handControl.status.text}</p>}
        {handControlOn && handDebug && <HandDebugPanel source={tracking.source} debug={handControl.debug} minFps={minFps} lossMs={lossMs} />}
        {tryingOn && <p className={`notice ${armTracking.status.endsWith('-error') ? 'warning' : ''}`} role="status" data-testid="try-on-status" data-state={armTracking.status}>{armStatusText[armTracking.status]}
          {armTracking.stats && <span className="small-muted" data-testid="try-on-stats"> · {armTracking.stats.delegate} · 每秒 {armTracking.stats.fps.toFixed(0)} 幀 · 辨識 {armTracking.stats.inferenceMs.toFixed(0)} ms · 偵測到手 {armTracking.stats.handFps.toFixed(0)}／對齊 {armTracking.stats.armFps.toFixed(0)} 次每秒{armTracking.stats.source && ` · 前臂依${armTracking.stats.source === 'elbow' ? '手肘' : '手部方向'}`}</span>}</p>}
        {active && <div className="explode-toolbar"><button type="button" className={`button ${explode > 0 ? 'active' : ''}`} aria-pressed={explode > 0} disabled={agentActive} onClick={() => setExplodeAmount(explode > 0 ? 0 : 1)}>{explode > 0 ? '收回爆炸圖' : '爆炸圖'}</button>
          <label className="explode-slider"><span>拆開程度</span><input type="range" min={0} max={100} step={1} value={Math.round(explode * 100)} aria-label="拆開程度" disabled={agentActive} onChange={event => setExplodeAmount(Number(event.target.value) / 100)} /><output>{Math.round(explode * 100)}%</output></label>
          <span className="small-muted">依零件階層在本機計算，不改模型資料、不呼叫 AI；拆開時停用拖曳把手。</span></div>}
        {cameraError && <p className="notice warning" role="alert">{cameraError}</p>}
        {renderError && <p className="notice warning" role="alert">{renderError}</p>}
        <div className="stage-note"><span className="note-index">01 /</span><p>青藍輪廓呈現零件邊界，琥珀色輪廓表示已選取。攝影機只在本機顯示；生成與修改服務接收你的文字與目前模型資料。</p></div>
      </section>
      <aside className="control-column">
        <AgentPanel agent={agent} disabled={Boolean(busy)} />
        <section className="panel prompt-panel">
          {active && <div className="mode-switch" role="tablist" aria-label="文字用途"><button role="tab" aria-selected={editing} className={editing ? 'active' : ''} onClick={() => setMode('edit')}>修改目前模型</button><button role="tab" aria-selected={!editing} className={!editing ? 'active' : ''} onClick={() => setMode('create')}>生成新物件</button></div>}
          {editing ? <>
            <span className="eyebrow">EDIT THIS CONCEPT</span><h2>想怎麼修改？</h2><p className="muted">只會變更需要改的零件；說「這個」代表已選取的零件。</p>
            <form onSubmit={e => { e.preventDefault(); void edit(); }}><label htmlFor="instruction">修改指示</label><textarea id="instruction" value={instruction} maxLength={4000} disabled={agentActive} onChange={e => setInstruction(e.target.value)} rows={4} placeholder="例如：四條桌腳加長到 50 公分，桌面跟著升高" />
              <div className="input-meta"><span>{selectedParts.length ? `參考已選取：${selectedParts.map(part => part.name).join('、')}` : '未選取零件：套用到整個模型'}</span><span>{instruction.length}/4000</span></div>
              <button className="button primary" type="submit" disabled={!instruction.trim() || agentActive}>套用修改 <span aria-hidden="true">↗</span></button></form>
          </> : <>
            <span className="eyebrow">CREATE A CONCEPT</span><h2>你想建立什麼？</h2><p className="muted">用自己的話描述，不需要固定指令。</p>
            <form onSubmit={e => { e.preventDefault(); void generate(); }}><label htmlFor="prompt">物件描述</label><textarea id="prompt" value={prompt} maxLength={4000} disabled={agentActive} onChange={e => setPrompt(e.target.value)} rows={5} placeholder="例如：一個帶兩個鏡頭、右側裝橘色電池的手持裝置" /><div className="input-meta"><span>形狀 · 色彩 · 件數 · 配置</span><span>{prompt.length}/4000</span></div><button className="button primary" type="submit" disabled={!prompt.trim() || agentActive || atLimit}>生成 3D 草案 <span aria-hidden="true">↗</span></button></form>
            {atLimit && <p className="notice warning" data-testid="object-limit">工作區最多 {MAX_OBJECTS} 個物件，請先刪除一個物件。</p>}
          </>}
          <div className="generation-status" aria-live="polite" role="status"><span className={`status-dot ${busy ? 'pulsing' : ''}`} /><span>{busyText}</span></div>
          {busy && <button className="text-button" onClick={() => { invalidateRequest(); setMessage('已取消等待，目前模型仍可操作。'); }}>{busy === 'edit' ? '取消這次修改' : '取消這次生成'}</button>}
          {error && <div className="notice warning" role="alert"><p>{error}</p><button className="text-button" disabled={agentActive} onClick={() => void (lastFailed.current === 'edit' ? edit() : generate())}>{lastFailed.current === 'edit' ? '重試修改' : '重試生成'}</button></div>}
          {clarify && <div className="notice clarify" data-testid="clarify"><strong>需要確認</strong><p>{clarify}</p><span className="small-muted">補充後再按「套用修改」，目前模型未變更。</span></div>}
          {editSummary && <div className="notice success" data-testid="edit-summary"><strong>已修改：{editSummary.changes}</strong><p>{editSummary.explanation}</p></div>}
          {conflict && <div className="approximation" data-testid="edit-conflict"><h3>修改衝突</h3><p>你在等待期間手動調整了：{conflict.parts.map(part => part.name).join('、')}。AI 的修改是根據調整前的模型產生的。</p><button className="button primary" disabled={agentActive} onClick={() => applyEdit(conflict.result.plan, conflict.result, conflict.startedAt, conflict.objectId)}>套用 AI 修改</button><button className="text-button" disabled={agentActive} onClick={() => { setConflict(null); setMessage('已保留你的手動調整，未套用這次 AI 修改。'); }}>保留手動調整</button></div>}
          {pending && <div className="approximation"><h3>近似方案待確認</h3><p>{pending.result.design.explanation}</p><ul>{pending.result.design.model?.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul><button className="button primary" disabled={agentActive || atLimit} onClick={() => { applyResult(pending.result, pending.startedAt); setPending(null); }}>接受近似並建立</button><button className="text-button" disabled={agentActive} onClick={() => { setPending(null); setMessage('已取消近似方案，上一個成功模型仍可操作。'); }}>取消近似</button></div>}
          <div className="service-status"><span className={`status-dot ${service?.configured ? 'connected' : 'unavailable'}`} /><div><strong>{service ? providerLabel(service.provider) : '本機服務未連線'}</strong><span>{service?.configured ? service.model : service?.reason || '尚未設定，請依 README 準備登入或金鑰。'}</span></div><button className="text-button" onClick={() => void refreshService()}>重新檢查</button></div><button className="text-button demo-link" onClick={loadDemo} disabled={agentActive || atLimit}>載入示範模型 <span>非 AI 生成</span></button>
        </section>
        {active && <ObjectPanel objects={workspace.objects} activeObjectId={workspace.activeObjectId} disabled={agentActive} error={objectError}
          onActivate={activateObject} onRename={renameObjectTo} onTransform={moveObject} onRemove={deleteObject} onMaterial={setObjectMaterial} />}
        {active && <JointPanel rows={jointRowList} showJoints={showJoints} mouseJoin={mouseJoin} mouseNotice={mouseNotice} error={jointError} disabled={agentActive}
          openJointId={cardJointId} onToggleShow={() => setShowJoints(on => !on)} onOpen={id => { setOpenJointId(id); setCardError(''); }}
          onStart={startMouseJoin} onConfirmJoin={confirmMouseJoin} onNextPair={() => stepMouseJoin({ type: 'next-pair' })} onCancelJoin={() => stepMouseJoin({ type: 'cancel' })}>
          {cardModel && cardJointId && <JointCard model={cardModel} disabled={agentActive || mouseJoin.step !== 'off'} askDisabled={agentActive || Boolean(busy)} error={cardError} preview={previewState}
            onNeeds={change => changeJoint(cardJointId, (ws, joint) => onNeeds(ws, joint, change, printer), JOINT_NOTICES.method)}
            onMethod={kind => changeJoint(cardJointId, (ws, joint) => onMethod(joint, kind, recommendJoint(ws, cardJointId, printer)), JOINT_NOTICES.method)}
            onParam={param => changeJoint(cardJointId, (_ws, joint) => onParam(joint, param), JOINT_NOTICES.method)}
            onConfirm={() => changeJoint(cardJointId, () => onConfirm(), JOINT_NOTICES.confirmed)}
            onUseRecommendation={() => changeJoint(cardJointId, ws => onRecommendation(recommendJoint(ws, cardJointId, printer)[0]!), JOINT_NOTICES.method)}
            onRealign={() => commitJointChange(ws => realignJoint(ws, cardJointId), JOINT_NOTICES.realigned, setCardError)}
            onPreview={target => void togglePrintPreview(target)}
            onAskAgent={() => { stepMouseJoin({ type: 'cancel' }); void agent.run(cardModel.actions.askAgent); }}
            onRemove={() => removeJointById(cardJointId)}
            onClose={() => { setOpenJointId(null); setCardError(''); }} />}
        </JointPanel>}
        {active && <PrinterPanel profile={printer} onChange={changePrinter} />}
        {active && <section className="panel parts-panel" aria-label="零件選取與調整">
          <div className="panel-heading"><span className="eyebrow">SELECT & ADJUST</span><span className="tag">{active.model.parts.length} 件</span></div>
          <h2>零件</h2>
          <ul className="part-picker" aria-label="零件清單">{active.model.parts.map(part => <li key={part.id}><button type="button" aria-pressed={selected.includes(part.id)} disabled={agentActive} className={selected.includes(part.id) ? 'selected' : ''} onClick={event => pick(active.id, part.id, event.shiftKey)}>
            <span className="color-chip" style={{ background: part.color }} /><span>{part.name}<small>{part.id}{part.parentId ? ` · 屬於 ${active.model.parts.find(p => p.id === part.parentId)?.name ?? part.parentId}` : ''}</small></span></button></li>)}</ul>
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
          {selectedParts.length > 0 && <div className="button-group editor-actions"><button type="button" className="button danger" disabled={agentActive} onClick={removeSelected}>刪除{selectedParts.length > 1 ? ` ${selectedParts.length} 個` : ''}零件</button><button type="button" className="text-button" disabled={agentActive} onClick={() => { selectInActive([]); setTransformMode(null); }}>取消選取</button></div>}
        </section>}
        <section className="panel details-panel"><div className="panel-heading"><span className="eyebrow">MODEL DETAILS</span><span className="tag">概念階段</span></div><h2>模型與假設</h2>{active ? <><p className="model-summary">{active.model.summary}</p><dl className="model-meta"><div><dt>來源</dt><dd>{sourceLabel}</dd></div><div><dt>生成模型</dt><dd>{active.providerModel}</dd></div><div><dt>資料版本 / 單位</dt><dd>{active.model.schemaVersion} / m（公尺）</dd></div>{timing !== null && <div><dt>送出至繪製提交</dt><dd>{(timing / 1000).toFixed(2)} 秒</dd></div>}</dl>{timing !== null && <p className="small-muted">本機觀測時間，含生成與繪製提交；尚非辨識品質或 GPU 完成量測。</p>}<h3>暫定假設</h3><ul className="assumptions">{active.model.assumptions.length ? active.model.assumptions.map((a, i) => <li key={i}>{a}</li>) : <li>未另列假設；概念尺寸仍需核對。</li>}</ul><details><summary>已建立零件（{active.model.parts.length}）</summary><ul className="parts-list">{active.model.parts.map(part => <li key={part.id}><span className="color-chip" style={{ background: part.color }} /><span>{part.name}<small>{part.id} · {part.role === 'interior' ? '內部概念件' : '外部件'}<br />{[part.dimensions.x, part.dimensions.y, part.dimensions.z].map(v => Number((v * 1000).toFixed(2))).join(' × ')} mm</small></span></li>)}</ul></details></> : <p className="empty-details">生成後會在這裡列出來源、實際零件與尺寸假設。<br />細節不足時，模型會清楚標示暫定配置。</p>}</section>
      </aside>
    </main>
    <footer className="app-footer"><span>FORGEHAND</span><span>概念視覺化 · 非工程量測或製造驗證</span></footer>
  </div>;
}
