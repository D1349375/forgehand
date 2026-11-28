import type { Measured, ScaleSource } from '../body';
import { formatMm } from '../fit-text';
import { defineText } from './define';
import type { Lang } from './lang';

/**
 * User-facing text of the body-fit panel, the measure steps, the card calibration and the tape input (body-fit Task 3),
 * in both languages (english-ui R58). Every new string of this task lives here; `shared/fit-text.ts` keeps the older
 * Traditional Chinese helpers of Task 1 and is not extended. The English side is plain English where the wording is not final.
 *
 * Function leaves take one flat object of strings, numbers or booleans, as the table test needs.
 */
export const FIT_UI = defineText({
  'zh-TW': {
    panel: {
      title: '試戴量測',
      object: '物件',
      noObject: '沒有物件',
      side: '戴在',
      sideLeft: '左手',
      sideRight: '右手',
      sideNone: '尚未偵測到手',
      end: '結束試戴',
      note: '量測值只留在這個瀏覽器分頁，關閉攝影機就清除。',
    },
    source: {
      heading: '尺寸來源',
      current: (p: { source: string }) => `目前：${p.source}`,
      estimate: '相機估計',
      card: '卡片校正',
      tape: '捲尺',
      none: '尚未量測',
    },
    measure: {
      heading: '量手腕',
      width: { button: '量寬度', title: '第 1 步：寬度', instruction: '手掌朝向鏡頭，手腕放鬆，保持不動。' },
      thickness: { button: '量厚度', title: '第 2 步：厚度', instruction: '把手腕轉 90°，讓拇指朝上。' },
      passage: { button: '量手掌最寬處', title: '第 3 步：手掌最寬處', instruction: '把拇指收向小指，手掌朝向鏡頭。', note: '只有封閉的手環需要這一步。' },
      stop: '停止量測',
      again: '重新量測',
      progress: (p: { n: number; total: number }) => `已記錄 ${p.n} / ${p.total} 幀`,
      reason: {
        noHand: '請把手放進鏡頭。',
        palm: '請把手掌正對鏡頭',
        thumbUp: '請把手腕轉成拇指朝上',
        flat: '請把手臂放平，和螢幕平行',
        still: '請保持不動',
        noMask: '看不到手腕輪廓，請讓手腕完整入鏡並保持不動。',
      },
      unstable: '量測不穩定，請保持不動再試一次。',
      segmenterLoading: '正在載入量測模型…',
      segmenterError: '量測模型無法載入，請改用捲尺輸入。',
      cpu: '目前使用 CPU，遮擋與量測會比較慢。',
      result: (p: { width: string; thickness: string; circumference: string }) => `寬 ${p.width} · 厚 ${p.thickness} · 周長 ${p.circumference}`,
      passageResult: (p: { value: string }) => `手掌最寬處 ${p.value}`,
      thicknessAssumed: '厚度依一般比例估計',
      done: '量測完成',
    },
    card: {
      heading: '卡片校正',
      start: '開始校正',
      needHand: '請先把手放進鏡頭。',
      instruction: '把一張信用卡大小的卡片平貼在手腕背面，長邊沿著手臂，對齊框線。',
      holdStill: '卡片放好後請保持不動，畫面會自動定格。',
      frozenHelp: '已定格。請拖曳四條邊對齊卡片，也可以用 Tab 選邊、方向鍵微調 1 px。',
      noEdges: '沒有自動找到卡片邊緣，請手動拖曳四條邊對齊卡片。',
      rejected: '卡片尺寸量起來不合理，請讓卡片平貼並正對鏡頭後重拍。',
      confirm: '確認',
      retake: '重拍',
      cancel: '取消校正',
      clear: '清除校正',
      guideLabel: '卡片校正框',
      frozenLabel: '定格畫面',
      edgeTop: '卡片上緣',
      edgeBottom: '卡片下緣',
      edgeLeft: '卡片左緣',
      edgeRight: '卡片右緣',
      biggerBy: (p: { percent: number }) => `校正完成：相機估計原本偏大 ${p.percent}%。`,
      smallerBy: (p: { percent: number }) => `校正完成：相機估計原本偏小 ${p.percent}%。`,
      same: '校正完成：相機估計與卡片相符。',
    },
    tape: {
      heading: '捲尺輸入',
      circumference: '手腕周長',
      width: '手腕寬度（選填）',
      thickness: '手腕厚度（選填）',
      unit: '單位',
      clear: '清除捲尺值',
      range: (p: { min: number; max: number }) => `請輸入 ${p.min}–${p.max} mm 之間的數值。`,
      inconsistent: '寬度（或厚度）與周長對不起來，請檢查輸入的數值。',
      same: '相機與捲尺相同',
      smaller: (p: { mm: string; percent: string }) => `相機偏小 ${p.mm} mm（${p.percent}%）`,
      bigger: (p: { mm: string; percent: string }) => `相機偏大 ${p.mm} mm（${p.percent}%）`,
      errorLine: (p: { source: string; camera: string; tape: string; verdict: string }) => `${p.source} ${p.camera} mm，捲尺 ${p.tape} mm，${p.verdict}`,
    },
    clearance: {
      heading: '餘量',
      help: '餘量是在手腕周長之外多留的長度。',
      snug: '貼合',
      comfort: '舒適',
      loose: '寬鬆',
      custom: '自訂',
      customLabel: '自訂餘量（mm）',
      value: (p: { mm: string }) => `${p.mm} mm`,
    },
  },
  en: {
    panel: {
      title: 'Try-on and measuring',
      object: 'Object',
      noObject: 'No object',
      side: 'Worn on',
      sideLeft: 'left hand',
      sideRight: 'right hand',
      sideNone: 'no hand detected yet',
      end: 'Stop try-on',
      note: 'Measurements stay in this browser tab and are cleared when the camera turns off.',
    },
    source: {
      heading: 'Size source',
      current: (p: { source: string }) => `Current: ${p.source}`,
      estimate: 'Camera estimate',
      card: 'Card calibration',
      tape: 'Tape measure',
      none: 'Not measured yet',
    },
    measure: {
      heading: 'Measure the wrist',
      width: { button: 'Measure width', title: 'Step 1: width', instruction: 'Face your palm to the camera, relax the wrist and hold still.' },
      thickness: { button: 'Measure thickness', title: 'Step 2: thickness', instruction: 'Turn the wrist 90° so the thumb points up.' },
      passage: { button: 'Measure widest hand', title: 'Step 3: widest part of the hand', instruction: 'Fold the thumb toward the little finger, palm to the camera.', note: 'Only a closed ring needs this step.' },
      stop: 'Stop measuring',
      again: 'Measure again',
      progress: (p: { n: number; total: number }) => `Recorded ${p.n} of ${p.total} frames`,
      reason: {
        noHand: 'Put your hand in front of the camera.',
        palm: 'Face your palm to the camera.',
        thumbUp: 'Turn the wrist so the thumb points up.',
        flat: 'Lay the arm flat, parallel to the screen.',
        still: 'Hold still.',
        noMask: 'The wrist outline is not visible. Keep the whole wrist in view and hold still.',
      },
      unstable: 'The measurement was not steady. Hold still and try again.',
      segmenterLoading: 'Loading the measuring model…',
      segmenterError: 'The measuring model could not load. Use the tape measure input instead.',
      cpu: 'Running on the CPU: occlusion and measuring will be slower.',
      result: (p: { width: string; thickness: string; circumference: string }) => `Width ${p.width} · thickness ${p.thickness} · circumference ${p.circumference}`,
      passageResult: (p: { value: string }) => `Widest part of the hand ${p.value}`,
      thicknessAssumed: 'Thickness assumed from a typical ratio',
      done: 'Measurement done',
    },
    card: {
      heading: 'Card calibration',
      start: 'Start calibration',
      needHand: 'Put your hand in front of the camera first.',
      instruction: 'Lay a credit-card-sized card flat on the back of the wrist, long edge along the arm, and match the frame.',
      holdStill: 'Hold still once the card is in place. The picture freezes by itself.',
      frozenHelp: 'Frozen. Drag the four edges onto the card, or press Tab to pick an edge and the arrow keys to move it by 1 px.',
      noEdges: 'The card edges were not found automatically. Drag the four edges onto the card by hand.',
      rejected: 'The card measures an unlikely size. Hold the card flat and square to the camera and retake.',
      confirm: 'Confirm',
      retake: 'Retake',
      cancel: 'Cancel calibration',
      clear: 'Clear calibration',
      guideLabel: 'Card calibration frame',
      frozenLabel: 'Frozen picture',
      edgeTop: 'Card top edge',
      edgeBottom: 'Card bottom edge',
      edgeLeft: 'Card left edge',
      edgeRight: 'Card right edge',
      biggerBy: (p: { percent: number }) => `Calibrated: the camera estimate was ${p.percent}% too large.`,
      smallerBy: (p: { percent: number }) => `Calibrated: the camera estimate was ${p.percent}% too small.`,
      same: 'Calibrated: the camera estimate matches the card.',
    },
    tape: {
      heading: 'Tape measure input',
      circumference: 'Wrist circumference',
      width: 'Wrist width (optional)',
      thickness: 'Wrist thickness (optional)',
      unit: 'Unit',
      clear: 'Clear tape values',
      range: (p: { min: number; max: number }) => `Enter a value between ${p.min} and ${p.max} mm.`,
      inconsistent: 'The width (or thickness) does not fit the circumference. Check the values.',
      same: 'camera and tape agree',
      smaller: (p: { mm: string; percent: string }) => `camera is ${p.mm} mm too small (${p.percent}%)`,
      bigger: (p: { mm: string; percent: string }) => `camera is ${p.mm} mm too large (${p.percent}%)`,
      errorLine: (p: { source: string; camera: string; tape: string; verdict: string }) => `${p.source} ${p.camera} mm, tape ${p.tape} mm, ${p.verdict}`,
    },
    clearance: {
      heading: 'Clearance',
      help: 'Clearance is the extra length left around the wrist circumference.',
      snug: 'Snug',
      comfort: 'Comfort',
      loose: 'Loose',
      custom: 'Custom',
      customLabel: 'Custom clearance (mm)',
      value: (p: { mm: string }) => `${p.mm} mm`,
    },
  },
});

/** The name of a scale source in `lang`. */
export const sourceName = (lang: Lang, source: ScaleSource): string => FIT_UI[lang].source[source];

/** A length with its spread but no source: `58 mm`, `58 mm ± 1.2 mm`. */
export function lengthText(value: Measured): string {
  return `${formatMm(value.mm)} mm${value.spreadMm === null ? '' : ` ± ${formatMm(value.spreadMm)} mm`}`;
}

/** A number with its source (R8) and, for camera values, its spread (R73): `155 mm ± 1.2 mm（相機估計）` or `165 mm (tape measure)`. */
export function measuredText(lang: Lang, value: Measured): string {
  const source = sourceName(lang, value.source);
  return lang === 'en' ? `${lengthText(value)} (${source})` : `${lengthText(value)}（${source}）`;
}

/** The camera estimate against the tape (R27, R111): `相機估計 155 mm，捲尺 165 mm，相機偏小 10 mm（6.1%）`. */
export function cameraErrorText(lang: Lang, cameraMm: number, tapeMm: number, cameraSource: ScaleSource): string {
  const text = FIT_UI[lang].tape;
  const difference = cameraMm - tapeMm;
  const percent = tapeMm > 0 ? (Math.abs(difference) / tapeMm * 100).toFixed(1) : '0.0';
  const mm = formatMm(Math.abs(difference));
  const verdict = Number(mm) === 0 ? text.same : difference < 0 ? text.smaller({ mm, percent }) : text.bigger({ mm, percent });
  return text.errorLine({ source: sourceName(lang, cameraSource), camera: formatMm(cameraMm), tape: formatMm(tapeMm), verdict });
}
