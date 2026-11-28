import { defineText } from './define';

/**
 * User-facing text of the design-fidelity spec, in both languages (english-ui R58). Every new string of
 * this spec lives here, so english-ui reviews one module. The English side is plain English where the
 * wording is not final.
 *
 * The model instructions are English and use the English labels below; the zh-TW labels are what the
 * interface shows. Nothing in this file depends on the reference table, so the table can import it.
 */

/** The detail-mode control (design-fidelity R23): its label, its two options and the help text. */
export const DETAIL_MODE_TEXT = defineText({
  'zh-TW': {
    label: '細節程度',
    concept: '概念',
    detailed: '詳細（含典型內部零件）',
    help: '詳細模式最多約 20 個零件，生成時間較長。',
  },
  en: {
    label: 'Level of detail',
    concept: 'Concept',
    detailed: 'Detailed (with typical internals)',
    help: 'Detailed mode uses up to about 20 parts and takes longer to generate.',
  },
});

/**
 * The generic name of each standard reference part (design-fidelity R25, R26). The keys are the ids of
 * `REFERENCE_PARTS` in shared/standard-parts.ts. Names are generic on purpose: never a brand or a product.
 */
export const REFERENCE_LABELS = defineText({
  'zh-TW': {
    'cell-18650': '典型 18650 圓柱鋰電池',
    'cell-aa': '典型 AA 電池',
    'cell-cr2032': '典型 CR2032 鈕扣電池',
    'cell-lipo-402030': '典型小型軟包鋰電池',
    'pcb-1-6': '典型電路板',
    'screw-m2': 'M2 內六角螺絲',
    'screw-m3': 'M3 內六角螺絲',
    'standoff-m2': 'M2 六角銅柱',
    'standoff-m3': 'M3 六角銅柱',
    'usb-c-receptacle': '典型 USB-C 母座',
    'motor-coin-10': '典型 10 mm 扁平震動馬達',
    'switch-tact-6': '典型 6 mm 輕觸開關',
    'led-5': '典型 5 mm LED',
    'speaker-40': '典型 40 mm 喇叭單體',
    'module-wireless': '典型 Wi-Fi／藍牙模組',
    'module-camera': '典型小型相機模組',
    thumbstick: '典型類比搖桿模組',
    'bearing-608': '608 滾珠軸承',
    'motor-bldc-22': '典型 22 系列無刷馬達',
    'wall-moulded-plastic': '一般射出塑膠外殼壁厚',
    'wall-fdm': '3D 列印外殼壁厚',
    'wall-aluminium': '一般鋁外殼壁厚',
  },
  en: {
    'cell-18650': 'typical 18650 cylindrical lithium cell',
    'cell-aa': 'typical AA battery',
    'cell-cr2032': 'typical CR2032 coin cell',
    'cell-lipo-402030': 'typical small lithium-polymer pouch cell',
    'pcb-1-6': 'typical circuit board',
    'screw-m2': 'M2 socket head cap screw',
    'screw-m3': 'M3 socket head cap screw',
    'standoff-m2': 'M2 hex standoff',
    'standoff-m3': 'M3 hex standoff',
    'usb-c-receptacle': 'typical USB-C receptacle',
    'motor-coin-10': 'typical 10 mm flat vibration motor',
    'switch-tact-6': 'typical 6 mm tactile switch',
    'led-5': 'typical 5 mm LED',
    'speaker-40': 'typical 40 mm speaker driver',
    'module-wireless': 'typical Wi-Fi / Bluetooth module',
    'module-camera': 'typical small camera module',
    thumbstick: 'typical analog thumbstick module',
    'bearing-608': '608 ball bearing',
    'motor-bldc-22': 'typical 22-series brushless motor',
    'wall-moulded-plastic': 'typical injection-moulded plastic enclosure wall',
    'wall-fdm': 'typical 3D-printed enclosure wall',
    'wall-aluminium': 'typical aluminium enclosure wall',
  },
});
