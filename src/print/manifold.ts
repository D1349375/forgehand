import type { ManifoldToplevel } from 'manifold-3d';

/**
 * Loads manifold-3d once (assembly-joints design 7.1). The library and its wasm are
 * fetched only when this is first called, so nothing reaches the first page load.
 * In Node the library finds its own wasm file next to its script; in the browser the
 * wasm is a bundled asset (`?url`), so no request leaves the app's own origin.
 */
let loading: Promise<ManifoldToplevel> | null = null;

const isNode = () => typeof process !== 'undefined' && !!process.versions?.node;

async function load(): Promise<ManifoldToplevel> {
  const { default: Module } = await import('manifold-3d');
  const config = isNode() ? undefined : await browserConfig();
  const wasm = await Module(config);
  wasm.setup();
  return wasm;
}

async function browserConfig(): Promise<{ locateFile: () => string }> {
  const { default: wasmUrl } = await import('manifold-3d/manifold.wasm?url');
  return { locateFile: () => wasmUrl };
}

/** The manifold-3d module, set up. Cached; a failed load can be retried. */
export function loadManifold(): Promise<ManifoldToplevel> {
  loading ??= load().catch(error => {
    loading = null;
    throw error;
  });
  return loading;
}
