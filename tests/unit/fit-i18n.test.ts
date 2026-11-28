import { describe, expect, it } from 'vitest';
import { cameraErrorText, FIT_UI, lengthText, measuredText, sourceName } from '../../shared/i18n/fit';

/** The strings of the requirements, in both languages (body-fit Task 3). The table shape itself is checked by i18n-tables.test.ts. */
describe('fit panel text', () => {
  it('writes a number with its source and spread in both languages (R8, R73)', () => {
    expect(measuredText('zh-TW', { mm: 165, source: 'tape', spreadMm: null })).toBe('165 mm（捲尺）');
    expect(measuredText('zh-TW', { mm: 155, source: 'estimate', spreadMm: 1.2 })).toBe('155 mm ± 1.2 mm（相機估計）');
    expect(measuredText('en', { mm: 155, source: 'card', spreadMm: 0.4 })).toBe('155 mm ± 0.4 mm (Card calibration)');
    expect(lengthText({ mm: 58.04, source: 'estimate', spreadMm: null })).toBe('58 mm');
    expect(sourceName('en', 'tape')).toBe('Tape measure');
  });

  it('writes the error line of the camera against the tape (R27)', () => {
    expect(cameraErrorText('zh-TW', 155, 165, 'estimate')).toBe('相機估計 155 mm，捲尺 165 mm，相機偏小 10 mm（6.1%）');
    expect(cameraErrorText('zh-TW', 170, 165, 'card')).toBe('卡片校正 170 mm，捲尺 165 mm，相機偏大 5 mm（3.0%）');
    expect(cameraErrorText('zh-TW', 165, 165, 'estimate')).toBe('相機估計 165 mm，捲尺 165 mm，相機與捲尺相同');
    expect(cameraErrorText('en', 155, 165, 'estimate')).toBe('Camera estimate 155 mm, tape 165 mm, camera is 10 mm too small (6.1%)');
  });

  it('keeps the texts of the requirements', () => {
    expect(FIT_UI['zh-TW'].tape.range({ min: 100, max: 300 })).toBe('請輸入 100–300 mm 之間的數值。');
    expect(FIT_UI['zh-TW'].card.instruction).toBe('把一張信用卡大小的卡片平貼在手腕背面，長邊沿著手臂，對齊框線。');
    expect(FIT_UI['zh-TW'].card.noEdges).toBe('沒有自動找到卡片邊緣，請手動拖曳四條邊對齊卡片。');
    expect(FIT_UI['zh-TW'].card.rejected).toBe('卡片尺寸量起來不合理，請讓卡片平貼並正對鏡頭後重拍。');
    expect(FIT_UI['zh-TW'].card.biggerBy({ percent: 4 })).toBe('校正完成：相機估計原本偏大 4%。');
    expect(FIT_UI['zh-TW'].measure.reason.still).toBe('請保持不動');
    expect(FIT_UI['zh-TW'].measure.unstable).toBe('量測不穩定，請保持不動再試一次。');
    expect(FIT_UI['zh-TW'].measure.segmenterError).toBe('量測模型無法載入，請改用捲尺輸入。');
  });
});
