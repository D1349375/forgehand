import { z } from 'zod';
import type { WearOnArmDetail } from '../../shared/agent';
import { noModel, ok } from './helpers';
import { defineTool } from './registry';

export const wearOnArm = defineTool({
  name: 'wear_on_arm',
  category: 'body',
  description: "toggles arm-tracking try-on. The try-on currently shows a stand-in cuff, not the user's design, so never say the design is being worn. If enabled and the camera is off, asks the user to turn it on (does not start the camera itself). Returns NO_MODEL if no model exists.",
  args: z.strictObject({ enabled: z.boolean() }),
  side: 'server',
  scope: 'project',
  effects: 'uses-camera',
  async run({ enabled }, { state }) {
    if (state.model === null) return noModel('wear_on_arm');
    // The tool never starts the camera (req 14); if it is off, ask the user.
    if (enabled && !state.cameraOn) {
      const detail: WearOnArmDetail = { tryOn: state.tryOn, cameraOn: false, message: '請先開啟攝影機再試戴。' };
      return { tool: 'wear_on_arm', ok: false, summary: '請先開啟攝影機再試戴。', detail, stateChange: null };
    }
    // The try-on shows the fixed stand-in cuff, not the user's design (see
    // docs/PRIOR_WORK.md). Be honest so the agent cannot claim the user's design
    // is being worn.
    const message = enabled ? '已開啟護臂試戴（目前顯示預設護臂，尚未套用你的設計）。' : '已關閉護臂試戴。';
    const detail: WearOnArmDetail = { tryOn: enabled, cameraOn: state.cameraOn, message };
    return ok('wear_on_arm', message, detail, { model: null, selection: null, explode: null, tryOn: enabled });
  },
});
