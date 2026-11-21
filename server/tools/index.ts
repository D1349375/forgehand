/**
 * Registers the working tools. Registration order is the order the model sees
 * them in `AGENT_INSTRUCTIONS`. Importing this module is what registers them.
 */
export { generateDesign } from './generate-design';
export { editDesign } from './edit-design';
export { selectParts } from './select-parts';
export { getProjectState } from './get-project-state';
export { explodeView } from './explode-view';
export { setActiveObject } from './set-active-object';
export { setTransform } from './set-transform';
export { removeObject } from './remove-object';
export { createJoint } from './create-joint';
export { updateJointTool } from './update-joint';
export { removeJoint } from './remove-joint';
export { setMaterial } from './set-material';
export { wearOnArm } from './wear-on-arm';
export { setCameraImage } from './set-camera-image';
export { prepareExport } from './prepare-export';
export { argKeys, argsShapeText, createToolRegistry, defineTool, getTool, listTools } from './registry';
export type { ToolContext, ToolDefinition, ToolEffects, ToolRegistry, ToolScope, ToolSide } from './registry';
