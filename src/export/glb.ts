import * as THREE from 'three';
import type { SceneObject } from '../../shared/workspace';
import { buildModel, disposeObject } from '../scene/geometry';

/**
 * The scene that becomes `workspace.glb`: metres, Y up, assembled. Each object is its model's root group (named after
 * the model, carrying the object transform); each part is a node named after the part, with display geometry and an
 * opaque material in the part's colour. `userData` becomes glTF `extras`. The caller disposes the scene.
 */
export function buildGlbScene(objects: readonly SceneObject[]): THREE.Scene {
  const scene = new THREE.Scene();
  scene.name = 'Forgehand';
  try {
    for (const object of objects) {
      const root = buildModel(object.model, (geometry, part) => {
        const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.55, metalness: 0 }));
        mesh.name = part.name;
        return mesh;
      });
      scene.add(root); // attach first so a failure below is cleaned up with the scene
      root.userData = { objectId: object.id, material: object.material };
      root.position.set(object.transform.position.x, object.transform.position.y, object.transform.position.z);
      root.rotation.set(
        THREE.MathUtils.degToRad(object.transform.rotation.x),
        THREE.MathUtils.degToRad(object.transform.rotation.y),
        THREE.MathUtils.degToRad(object.transform.rotation.z),
      );
      root.traverse((node) => {
        if (node === root || typeof node.userData.partId !== 'string') return;
        node.name = node.userData.partName as string;
        node.userData = { ...node.userData, objectId: object.id, material: object.material };
      });
    }
    scene.updateMatrixWorld(true);
    return scene;
  } catch (error) {
    disposeObject(scene);
    throw error;
  }
}

/** Binary glTF of the scene. Needs a browser (`GLTFExporter` reads blobs with `FileReader`). */
export async function writeGlb(objects: readonly SceneObject[]): Promise<Uint8Array> {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const scene = buildGlbScene(objects);
  try {
    const result = await new GLTFExporter().parseAsync(scene, { binary: true });
    if (!(result instanceof ArrayBuffer)) throw new Error('GLB export did not return binary data.');
    return new Uint8Array(result);
  } finally {
    disposeObject(scene);
  }
}
