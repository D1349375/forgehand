export const DEFAULT_E2E_PORT = 5197;
export const DEFAULT_E2E_API_PORT = 8797;

export interface E2ePorts {
  port: number;
  apiPort: number;
  localUrl: string;
}

function readPort(name: string, raw: string | undefined, fallback: number): number {
  const text = raw === undefined || raw.trim() === '' ? String(fallback) : raw.trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be an integer between 1024 and 65535`);
  }
  return value;
}

/** Ports for the e2e test server, kept apart from the dev server's 5173/8787. */
export function e2ePorts(env: Record<string, string | undefined>): E2ePorts {
  const port = readPort('E2E_PORT', env.E2E_PORT, DEFAULT_E2E_PORT);
  const apiPort = readPort('E2E_API_PORT', env.E2E_API_PORT, DEFAULT_E2E_API_PORT);
  if (port === apiPort) throw new Error('E2E_PORT and E2E_API_PORT must be different');
  return { port, apiPort, localUrl: `http://127.0.0.1:${port}` };
}
