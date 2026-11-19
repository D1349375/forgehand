import type { AgentWorkingState } from '../../server/agent-tools';
import { demoModel } from '../../shared/demo';
import type { ModelSpec } from '../../shared/model';
import {
  addObject, emptyWorkspace, selectParts, setActiveObject, setExplode,
  type SceneObject, type Workspace,
} from '../../shared/workspace';

/** Builders for agent tests: workspaces and working states made with the real operations. */

export const CREATED_AT = '2026-11-20T08:00:00.000Z';

export function sceneObject(id: string, model: ModelSpec = demoModel, x = 0): SceneObject {
  return {
    id,
    model: structuredClone(model),
    transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    source: 'demo',
    providerModel: 'demo',
    edited: false,
    material: null,
    createdAt: CREATED_AT,
  };
}

/** A workspace holding the given objects; the first one is active. */
export function workspaceOf(...objects: SceneObject[]): Workspace {
  let ws = emptyWorkspace();
  for (const object of objects) ws = addObject(ws, object);
  return objects.length > 0 ? setActiveObject(ws, objects[0]!.id) : ws;
}

export interface StateOptions {
  selection?: string[];
  explode?: number;
  tryOn?: boolean;
  cameraOn?: boolean;
}

/** A working state over `workspace`. `selection` applies to the active object. */
export function stateOver(workspace: Workspace, options: StateOptions = {}): AgentWorkingState {
  let ws = workspace;
  if (options.selection?.length && ws.activeObjectId !== null) ws = selectParts(ws, ws.activeObjectId, options.selection);
  if (options.explode !== undefined) ws = setExplode(ws, options.explode);
  return { workspace: ws, tryOn: options.tryOn ?? false, cameraOn: options.cameraOn ?? false };
}

/** One demo object `obj-1`, active. */
export const withModel = (options: StateOptions = {}): AgentWorkingState =>
  stateOver(workspaceOf(sceneObject('obj-1')), options);

/** An empty workspace. */
export const noModel = (options: StateOptions = {}): AgentWorkingState =>
  stateOver(workspaceOf(), options);

/** A counter for `newObjectId`: `new-1`, `new-2`, ... */
export function idCounter(prefix = 'new'): () => string {
  let count = 0;
  return () => `${prefix}-${++count}`;
}
