import * as THREE from 'three';
import type { Part } from '../../shared/model';

export const HOLOGRAM = Object.freeze({ edgeColor: '#69eaff', shellOpacity: 0.34, interiorOpacity: 0.72, inactiveFactor: 0.4 });

/** Presentation uses only existing parts and never invents interior structures. */
export function hologramPart(geometry: THREE.BufferGeometry, part: Part): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: part.color,
    emissive: part.color,
    emissiveIntensity: 0.14,
    transparent: true,
    opacity: part.role === 'interior' ? HOLOGRAM.interiorOpacity : HOLOGRAM.shellOpacity,
    roughness: 0.42,
    metalness: 0.18,
    side: THREE.DoubleSide,
    depthWrite: part.role === 'interior',
  }));
  mesh.name = `${part.id}:surface`;
  // Base opacities are stored so dimming can scale and restore them without a rebuild.
  mesh.userData.baseOpacity = part.role === 'interior' ? HOLOGRAM.interiorOpacity : HOLOGRAM.shellOpacity;
  // X-ray presentation draws actual interior pieces after the translucent
  // shell. Interior depth prevents a rear board from tinting a front part.
  mesh.renderOrder = part.role === 'interior' ? 1 : 0;
  group.add(mesh);
  // Creases, rather than triangle wireframes, preserve readable silhouettes.
  const edges = new THREE.EdgesGeometry(geometry, 24);
  const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: HOLOGRAM.edgeColor, transparent: true, opacity: 0.88, depthWrite: false }));
  line.name = `${part.id}:edges`;
  line.userData.baseOpacity = 0.88;
  line.renderOrder = 2;
  group.add(line);
  // Great circles are sparse geometric guides on otherwise smooth surfaces.
  if (part.primitive === 'sphere' || part.primitive === 'torus') {
    const rings = part.primitive === 'sphere' ? [0, 1, 2] : [0, 1];
    rings.forEach((index) => {
      const points: THREE.Vector3[] = [];
      for (let step = 0; step < 80; step++) {
        const angle = step / 80 * Math.PI * 2;
        const a = Math.cos(angle), b = Math.sin(angle);
        if (part.primitive === 'sphere') {
          points.push(index === 0 ? new THREE.Vector3(a * part.dimensions.x / 2, b * part.dimensions.y / 2, 0)
            : index === 1 ? new THREE.Vector3(a * part.dimensions.x / 2, 0, b * part.dimensions.z / 2)
            : new THREE.Vector3(0, a * part.dimensions.y / 2, b * part.dimensions.z / 2));
        } else {
          const radius = index === 0 ? 0.5 : 0.25;
          points.push(new THREE.Vector3(a * part.dimensions.x * radius, b * part.dimensions.y * radius, 0));
        }
      }
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: HOLOGRAM.edgeColor, transparent: true, opacity: 0.55, depthWrite: false }));
      ring.userData.baseOpacity = 0.55;
      group.add(ring);
    });
  }
  return group;
}

export const SELECTION = Object.freeze({ edgeColor: '#ffc53d', emissiveIntensity: 0.5 });

/**
 * Selection is presentation only: it changes outline colour and glow, never
 * the part's own colour or geometry, and can be toggled without a rebuild.
 * `dimmed` draws a part of an inactive object: every surface and edge opacity
 * is the base opacity (stored at build time) times `HOLOGRAM.inactiveFactor`.
 */
export function applyPartStyle(group: THREE.Object3D, style: { selected: boolean; dimmed: boolean }): void {
  const { selected, dimmed } = style;
  const factor = dimmed ? HOLOGRAM.inactiveFactor : 1;
  group.traverse(object => {
    if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshStandardMaterial) {
      const base = typeof object.userData.baseOpacity === 'number' ? object.userData.baseOpacity : object.material.opacity;
      object.userData.baseOpacity = base;
      object.material.emissiveIntensity = selected ? SELECTION.emissiveIntensity : 0.14;
      object.material.opacity = base * factor;
    } else if (object instanceof THREE.Line && object.material instanceof THREE.LineBasicMaterial) {
      const base = typeof object.userData.baseOpacity === 'number' ? object.userData.baseOpacity : object.material.opacity;
      object.userData.baseOpacity = base;
      object.material.color.set(selected ? SELECTION.edgeColor : HOLOGRAM.edgeColor);
      object.material.opacity = (selected ? 1 : base) * factor;
      // Selected outlines stay visible through other translucent parts.
      object.material.depthTest = !selected;
      object.renderOrder = selected ? 3 : object.name.endsWith(':edges') ? 2 : 0;
    }
  });
}
export function applySelectionStyle(group: THREE.Object3D, selected: boolean): void {
  applyPartStyle(group, { selected, dimmed: false });
}
