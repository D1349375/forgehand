import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { FIT_UI } from '../../shared/i18n/fit';
import { useLang } from '../i18n/LanguageProvider';
import {
  cardCorners, coverMap, frameToGuide, frameToView, guideEdges, guideToFrame, viewToFrame, type CardEdge, type CardEdges, type CardGuide as Guide, type CoverMap, type Point,
} from './card';
import type { BodyFitApi, FrozenCard, LiveGuideState } from './useBodyFit';

const EDGES: readonly CardEdge[] = ['top', 'bottom', 'left', 'right'];
/** The card may not shrink below this many frame pixels on a side while an edge is dragged. */
const MIN_SIDE_PX = 8;
const points = (corners: readonly Point[]) => corners.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');

/** The screen direction (unit vector) in which an edge moves when its coordinate grows. */
function normalOf(guide: Guide, edge: CardEdge): Point {
  const a = guide.angleDeg * Math.PI / 180;
  return edge === 'left' || edge === 'right' ? { x: Math.cos(a), y: Math.sin(a) } : { x: -Math.sin(a), y: Math.cos(a) };
}

/** The midpoint of an edge in frame pixels. */
function edgeMidpoint(guide: Guide, edges: CardEdges, edge: CardEdge): Point {
  const midU = (edges.left + edges.right) / 2;
  const midV = (edges.top + edges.bottom) / 2;
  if (edge === 'left') return guideToFrame(guide, edges.left, midV);
  if (edge === 'right') return guideToFrame(guide, edges.right, midV);
  return edge === 'top' ? guideToFrame(guide, midU, edges.top) : guideToFrame(guide, midU, edges.bottom);
}

/** `edges` with one edge moved to `value` (guide coordinates), never closer to its opposite edge than `MIN_SIDE_PX`. */
function moveEdge(edges: CardEdges, edge: CardEdge, value: number): CardEdges {
  switch (edge) {
    case 'left': return { ...edges, left: Math.min(value, edges.right - MIN_SIDE_PX) };
    case 'right': return { ...edges, right: Math.max(value, edges.left + MIN_SIDE_PX) };
    case 'top': return { ...edges, top: Math.min(value, edges.bottom - MIN_SIDE_PX) };
    default: return { ...edges, bottom: Math.max(value, edges.top + MIN_SIDE_PX) };
  }
}

/**
 * The card calibration layer (R11 to R14), drawn over the camera view in the overlay layer (R81) and in the video's
 * coordinates. While the user aims the card it shows the guide frame, redrawn from the tracking callback without a React
 * render. After the hand has been still it shows the frozen picture with the four edges as draggable and keyboard-movable
 * handles. The frozen picture is an `ImageBitmap` that the engine closes when the layer closes; it is never sent anywhere (R108).
 */
export function CardGuide({ bodyFit }: { bodyFit: BodyFitApi }) {
  const { lang } = useLang();
  const text = FIT_UI[lang].card;
  const phase = bodyFit.live.card;
  if (phase === 'off') return null;
  return <div className="fit-layer" data-testid="card-guide" data-phase={phase} role="group" aria-label={text.guideLabel}>
    {phase === 'aiming' && <AimingGuide bodyFit={bodyFit} />}
    {phase === 'frozen' && bodyFit.frozen && <FrozenGuide bodyFit={bodyFit} frozen={bodyFit.frozen} />}
  </div>;
}

function AimingGuide({ bodyFit }: { bodyFit: BodyFitApi }) {
  const { lang } = useLang();
  const text = FIT_UI[lang].card;
  const svg = useRef<SVGSVGElement>(null);
  const polygon = useRef<SVGPolygonElement>(null);
  useEffect(() => {
    let last: LiveGuideState | null = bodyFit.guide.current();
    const draw = () => {
      const element = svg.current, shape = polygon.current;
      if (!element || !shape) return;
      if (!last) { shape.setAttribute('visibility', 'hidden'); return; }
      const box = element.getBoundingClientRect();
      const map = coverMap({ width: box.width, height: box.height }, last.frame);
      const corners = cardCorners(last.guide, guideEdges(last.guide)).map(point => frameToView(map, point));
      shape.setAttribute('points', points(corners));
      shape.setAttribute('visibility', 'visible');
      shape.setAttribute('data-inside', String(last.inside));
      shape.setAttribute('data-still', last.still.toFixed(2));
    };
    draw();
    const off = bodyFit.guide.subscribe(state => { last = state; draw(); });
    const observer = new ResizeObserver(draw);
    if (svg.current) observer.observe(svg.current);
    return () => { off(); observer.disconnect(); };
  }, [bodyFit.guide]);
  return <>
    <svg ref={svg} className="fit-guide-svg" aria-hidden="true">
      <polygon ref={polygon} className="fit-guide-card" visibility="hidden" data-testid="card-guide-frame" />
    </svg>
    <div className="fit-banner">
      <p>{text.instruction}</p>
      <p className="small-muted">{text.holdStill}</p>
      <button type="button" className="button" onClick={() => bodyFit.cancelCard()}>{text.cancel}</button>
    </div>
  </>;
}

function FrozenGuide({ bodyFit, frozen }: { bodyFit: BodyFitApi; frozen: FrozenCard }) {
  const { lang } = useLang();
  const text = FIT_UI[lang].card;
  const layer = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [edges, setEdges] = useState<CardEdges>(frozen.detection.edges);
  const [error, setError] = useState(false);
  const drag = useRef<CardEdge | null>(null);
  const { guide, frame } = frozen;
  const map: CoverMap = coverMap(box, frame);
  const labels: Record<CardEdge, string> = { top: text.edgeTop, bottom: text.edgeBottom, left: text.edgeLeft, right: text.edgeRight };

  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    const bitmap = frozen.picture.bitmap;
    if (!element || !context || !bitmap || !box.width || !box.height) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(box.width * ratio);
    element.height = Math.round(box.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, box.width, box.height);
    const shown = coverMap(box, frame);
    context.drawImage(bitmap, shown.offsetX, shown.offsetY, frame.width * shown.scale, frame.height * shown.scale);
  }, [box, frozen, frame]);

  const corners = cardCorners(guide, edges).map(point => frameToView(map, point));

  function setFromPointer(edge: CardEdge, event: PointerEvent<HTMLElement>) {
    const rect = layer.current?.getBoundingClientRect();
    if (!rect) return;
    const local = frameToGuide(guide, viewToFrame(map, { x: event.clientX - rect.left, y: event.clientY - rect.top }));
    setEdges(current => moveEdge(current, edge, edge === 'left' || edge === 'right' ? local.x : local.y));
    setError(false);
  }
  function onKey(edge: CardEdge, event: KeyboardEvent<HTMLElement>) {
    const direction = ({ ArrowRight: { x: 1, y: 0 }, ArrowLeft: { x: -1, y: 0 }, ArrowDown: { x: 0, y: 1 }, ArrowUp: { x: 0, y: -1 } } as Record<string, Point>)[event.key];
    if (!direction) return;
    event.preventDefault();
    // The edge moves one frame pixel toward the arrow's screen direction, when that direction is along its normal.
    const normal = normalOf(guide, edge);
    const along = normal.x * direction.x + normal.y * direction.y;
    if (Math.abs(along) < 0.35) return;
    setEdges(current => moveEdge(current, edge, current[edge] + (along > 0 ? 1 : -1)));
    setError(false);
  }
  function confirm() {
    const result = bodyFit.confirmCard(edges);
    if (!result.ok) setError(true);
  }

  return <div ref={layer} className="fit-frozen" data-testid="card-frozen" data-found={String(frozen.detection.found)}>
    <canvas ref={canvas} className="fit-frozen-canvas" role="img" aria-label={text.frozenLabel} />
    <svg className="fit-guide-svg" aria-hidden="true">
      <polygon className="fit-guide-card" points={points(corners)} />
    </svg>
    {EDGES.map(edge => {
      const place = frameToView(map, edgeMidpoint(guide, edges, edge));
      return <div key={edge} role="slider" tabIndex={0} className={`fit-handle ${edge}`} data-edge={edge} aria-label={labels[edge]}
        aria-orientation={edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical'}
        aria-valuemin={Math.round(-guide.longPx)} aria-valuemax={Math.round(guide.longPx)} aria-valuenow={Math.round(edges[edge] * 10) / 10}
        style={{ left: place.x, top: place.y }}
        onKeyDown={event => onKey(edge, event)}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = edge; }}
        onPointerMove={event => { if (drag.current === edge) setFromPointer(edge, event); }}
        onPointerUp={event => { if (drag.current === edge) { setFromPointer(edge, event); drag.current = null; } }}
        onPointerCancel={() => { drag.current = null; }} />;
    })}
    <div className="fit-banner">
      <p>{text.frozenHelp}</p>
      {!frozen.detection.found && <p className="fit-note warning" role="status" data-testid="card-no-edges">{text.noEdges}</p>}
      {error && <p className="fit-note warning" role="alert" data-testid="card-rejected">{text.rejected}</p>}
      <div className="button-group">
        <button type="button" className="button primary" onClick={confirm}>{text.confirm}</button>
        <button type="button" className="button" onClick={() => bodyFit.retakeCard()}>{text.retake}</button>
        <button type="button" className="button" onClick={() => bodyFit.cancelCard()}>{text.cancel}</button>
      </div>
    </div>
  </div>;
}
