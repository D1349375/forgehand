import { validateModel, type ModelSpec, type Part } from './model';

const part = (values: Partial<Part> & Pick<Part, 'id' | 'name'>): Part => ({
  parentId: null,
  primitive: 'box',
  dimensions: { x: 0.1, y: 0.1, z: 0.1 },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  color: '#59d9e8',
  role: 'exterior',
  tubeRatio: 0.75,
  ...values,
});

// Explicitly selected local demonstration data, never a substitute for AI.
export const demoModel: ModelSpec = validateModel({
  schemaVersion: '1.0',
  name: '雙鏡頭概念裝置',
  summary: '本機示範資料：半透明外殼、兩個鏡筒、側邊電池與內部電路概念件。',
  units: 'm',
  assumptions: [
    '這是預先建立的示範資料，並非 AI 生成。',
    '外殼是壁厚 2 mm 的中空殼體；外形尺寸為示範用暫定值。',
    '內部電路位置為概念示意，未經工程驗證。',
  ],
  parts: [
    // A 2.0 mm wall: wall = (1 - tubeRatio) * 0.07 / 2.
    part({ id: 'housing', name: '外殼', primitive: 'shell', dimensions: { x: 0.16, y: 0.09, z: 0.07 }, tubeRatio: 1 - (2 * 0.002) / 0.07 }),
    ...[-1, 1].flatMap((side, index) => [
      part({ id: `lens-${index + 1}`, name: `鏡筒 ${index + 1}`, parentId: 'housing', primitive: 'tube',
        dimensions: { x: 0.048, y: 0.05, z: 0.048 }, position: { x: side * 0.04, y: 0.003, z: 0.053 },
        rotation: { x: 90, y: 0, z: 0 }, color: '#80b9d4' }),
      part({ id: `glass-${index + 1}`, name: `鏡片 ${index + 1}`, parentId: 'housing', primitive: 'cylinder',
        dimensions: { x: 0.034, y: 0.004, z: 0.034 }, position: { x: side * 0.04, y: 0.003, z: 0.077 },
        rotation: { x: 90, y: 0, z: 0 }, color: '#6ad7f2' }),
    ]),
    part({ id: 'battery', name: '側邊電池', parentId: 'housing', dimensions: { x: 0.035, y: 0.068, z: 0.05 },
      position: { x: 0.099, y: -0.005, z: 0 }, color: '#f27562' }),
    part({ id: 'board', name: '內部電路概念件', parentId: 'housing', dimensions: { x: 0.12, y: 0.004, z: 0.045 },
      position: { x: 0, y: -0.022, z: 0 }, role: 'interior', color: '#5fd5a1' }),
    part({ id: 'support', name: '展示支架', dimensions: { x: 0.025, y: 0.075, z: 0.025 },
      position: { x: 0, y: -0.0825, z: 0 }, color: '#a1c9d2' }),
    part({ id: 'base', name: '展示底座', primitive: 'cylinder', dimensions: { x: 0.13, y: 0.012, z: 0.10 },
      position: { x: 0, y: -0.126, z: 0 }, color: '#9fcedc' }),
  ],
});
