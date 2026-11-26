import type { Closure, FitClass, FitSummary, Measured, ScaleSource } from './body';
import { CLASS_CHARS } from './fit-constants';
import { classRuns, type ClassRun } from './fit';

/**
 * Every user-facing string of body fit, for the browser and the server tools (R83): one
 * table of Traditional Chinese strings and small template functions. Later tasks add
 * their rows here and never write fit text inline. `english-ui` replaces this file.
 */

const roundTenth = (value: number) => Math.round(value * 10) / 10 + 0;

/** A length in millimetres with at most one decimal: `58`, `1.5`. */
export const formatMm = (value: number): string => String(roundTenth(value));

export const sourceLabel = (source: ScaleSource): string => ({ estimate: '相機估計', card: '卡片校正', tape: '捲尺' })[source];

/** Side of the wrist for a body angle: 0 back of the hand, 90 thumb side, 180 palm side, 270 little-finger side (R54). */
export function sideLabel(angleDeg: number): string {
  const angle = ((angleDeg % 360) + 360) % 360;
  if (angle < 45 || angle >= 315) return '手背側';
  if (angle < 135) return '拇指側';
  if (angle < 225) return '掌心側';
  return '小指側';
}

/** A number with its source and, when it has one, its spread: `165 mm（捲尺）`, `155 mm ± 1.2 mm（相機估計）` (R8, R73). */
export function formatMeasured(value: Measured): string {
  const spreadText = value.spreadMm === null ? '' : ` ± ${formatMm(value.spreadMm)} mm`;
  return `${formatMm(value.mm)} mm${spreadText}（${sourceLabel(value.source)}）`;
}

export const classLabel = (cls: FitClass): string => ({ fits: '合適', presses: '壓迫', loose: '偏鬆' })[cls];

const CLASS_OF_CHAR: Record<string, FitClass> = { [CLASS_CHARS.fits]: 'fits', [CLASS_CHARS.presses]: 'presses', [CLASS_CHARS.loose]: 'loose' };

export const clearanceLabel = (preset: 'snug' | 'comfort' | 'loose' | 'custom'): string =>
  ({ snug: '貼合', comfort: '舒適', loose: '寬鬆', custom: '自訂' })[preset];

export const closureLabel = (closure: Closure): string => ({ closed: '封閉', open: '開口', clasp: '有扣環或可打開' })[closure];

export const FIT_TEXT = {
  // R24 to R28
  thicknessAssumed: '厚度依一般比例估計',
  tapeRange: (min: number, max: number) => `請輸入 ${min}–${max} mm 之間的數值。`,
  tapeInconsistent: '寬度（或厚度）與周長對不起來，請檢查輸入的數值。',
  wristResult: (width: Measured, thickness: Measured, circumference: Measured) =>
    `寬 ${formatMm(width.mm)} mm · 厚 ${formatMm(thickness.mm)} mm · 周長 ${formatMeasured(circumference)}`,
  /** The camera estimate against the tape (R27, R111): `相機估計 155 mm，捲尺 165 mm，相機偏小 10 mm（6.1%）`. */
  cameraError: (cameraMm: number, tapeMm: number, cameraSource: ScaleSource = 'estimate') => {
    const difference = cameraMm - tapeMm;
    const percent = tapeMm > 0 ? Math.abs(difference) / tapeMm * 100 : 0;
    const verdict = roundTenth(Math.abs(difference)) === 0 ? '相機與捲尺相同' : `相機${difference < 0 ? '偏小' : '偏大'} ${formatMm(Math.abs(difference))} mm（${percent.toFixed(1)}%）`;
    return `${sourceLabel(cameraSource)} ${formatMm(cameraMm)} mm，捲尺 ${formatMm(tapeMm)} mm，${verdict}`;
  },
  // R47, R52
  closureTitle: '開合方式',
  cannotPass: '封閉手環的內圍小於手掌最寬處，戴不進去。可加大內圍或改成有扣環。',
  cannotPassState: '套不過手掌',
  axisBlocked: '環內有零件擋住',
  // R54
  noRing: '這個物件沒有環繞手腕的部分，只顯示位置。',
  inner: (summary: FitSummary) =>
    `內圍 ${formatMm(summary.innerMm ?? 0)} mm · 手腕 ${formatMeasured(summary.wrist)}· 餘量 ${formatMm(summary.spareMm ?? 0)} mm`,
  opening: (openingDeg: number, openingAtDeg: number) => `開口 ${formatMm(openingDeg)}°（${sideLabel(openingAtDeg)}）`,
  tightest: (summary: FitSummary) => `最緊 ${formatMm(summary.minGap.mm)} mm（${sideLabel(summary.minGap.angleDeg)}）`,
  loosest: (summary: FitSummary) => `最鬆 ${formatMm(summary.maxGap.mm)} mm（${sideLabel(summary.maxGap.angleDeg)}）`,
  /** `壓迫：拇指側 60°–110°`; the side is the one of the run's middle angle. */
  range: (cls: FitClass, run: ClassRun) => `${classLabel(cls)}：${sideLabel(run.midDeg)} ${formatMm(run.fromDeg)}°–${formatMm(run.toDeg)}°`,
  // R66, R68, R71
  noMeasurement: '還沒有手腕尺寸。請先在試戴面板量測手腕或輸入捲尺數值。',
  noRingToFit: '找不到可以環繞手腕的零件。請先指定環形零件，或讓物件有一個環。',
  fitOutOfRange: '調整後的尺寸超出零件的限制。請換一個環形零件、縮小餘量，或請 AI 調整。',
  resizeRound: '環的方向不是正對手腕，已改成圓形內圈。',
  jointNotFollowed: '接合的物件沒有跟著移動，請檢查接合位置。',
  resizeExplanation: (partName: string) => `調整環形零件「${partName}」的內圍以符合手腕。`,
  resizeButton: '調整為合適尺寸',
  resizeNeedsAi: '這個形狀請交給 AI 調整。',
} as const;

/** The angle ranges of every class of a summary, worst first: 壓迫, 偏鬆, 合適 (R54). */
export function rangeLines(summary: FitSummary): string[] {
  const order: FitClass[] = ['presses', 'loose', 'fits'];
  const runs = classRuns(summary.classes);
  return order.flatMap(cls => runs.filter(run => CLASS_OF_CHAR[run.cls] === cls).map(run => FIT_TEXT.range(cls, run)));
}

/**
 * The numbers of R54 as lines: inner perimeter with wrist and spare (or the opening, or the no-ring
 * notice), the tightest and loosest point, and the class ranges.
 */
export function summaryLines(summary: FitSummary): string[] {
  if (summary.state === 'no-ring') return [FIT_TEXT.noRing];
  const lines: string[] = [];
  if (summary.openingDeg !== null && summary.openingAtDeg !== null) lines.push(FIT_TEXT.opening(summary.openingDeg, summary.openingAtDeg));
  else if (summary.innerMm !== null) lines.push(FIT_TEXT.inner(summary));
  if (summary.state === 'cannot-pass') lines.push(FIT_TEXT.cannotPass);
  else lines.push(FIT_TEXT.tightest(summary), FIT_TEXT.loosest(summary), ...rangeLines(summary));
  return lines;
}

/**
 * The result line of `fit_to_body` (R68): `已調整：內圍 171 mm，手腕 165 mm（捲尺），餘量 6 mm（貼合）。全部角度合適。`
 * When some angle is still tight or loose it names the sides and offers another try.
 */
export function fitResultLine(summary: FitSummary, clearancePreset: 'snug' | 'comfort' | 'loose' | 'custom'): string {
  if (summary.state === 'no-ring') return FIT_TEXT.noRing;
  const head = summary.innerMm === null
    ? `已調整：${FIT_TEXT.opening(summary.openingDeg ?? 0, summary.openingAtDeg ?? 0)}，手腕 ${formatMeasured(summary.wrist)}。`
    : `已調整：內圍 ${formatMm(summary.innerMm)} mm，手腕 ${formatMeasured(summary.wrist)}，餘量 ${formatMm(summary.spareMm ?? 0)} mm（${clearanceLabel(clearancePreset)}）。`;
  if (summary.state === 'cannot-pass') return `${head}${FIT_TEXT.cannotPass}`;
  if (summary.state === 'fits') return `${head}全部角度合適。`;
  const problems = rangeLines(summary).filter(line => !line.startsWith(classLabel('fits')));
  return `${head}還有地方不合適（${problems.join('；')}）。可以再試一次。`;
}
