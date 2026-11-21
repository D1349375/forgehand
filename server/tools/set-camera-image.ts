import { z } from 'zod';
import type { SetCameraImageDetail } from '../../shared/agent';
import { ok } from './helpers';
import { defineTool } from './registry';

const CAMERA_OFF_MESSAGE = '請先開啟攝影機。';

export const setCameraImage = defineTool({
  name: 'set_camera_image',
  label: '鏡頭畫面',
  category: 'view',
  description: 'shows or hides the live camera image behind the model; hand tracking and try-on keep running. Asks the user to turn the camera on if it is off.',
  args: z.strictObject({ visible: z.boolean() }),
  side: 'server',
  scope: 'project',
  effects: 'uses-camera',
  async run({ visible }, { state }) {
    // The tool never starts the camera; it does not need a model either.
    if (!state.cameraOn) {
      const detail: SetCameraImageDetail = { visible, cameraOn: false, message: CAMERA_OFF_MESSAGE };
      return { tool: 'set_camera_image', ok: false, summary: CAMERA_OFF_MESSAGE, detail, stateChange: null };
    }
    const message = visible ? '已顯示鏡頭畫面。' : '已隱藏鏡頭畫面（手部追蹤持續進行）。';
    const detail: SetCameraImageDetail = { visible, cameraOn: true, message };
    return ok('set_camera_image', message, detail, {
      activeObjectId: null, object: null, selection: null, explode: null, tryOn: null, cameraHidden: !visible,
    });
  },
});
