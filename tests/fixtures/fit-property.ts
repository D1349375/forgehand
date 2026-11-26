import fc from 'fast-check';

/**
 * Runs a fast-check property and keeps the number of generated cases, so the T1 report can
 * state it. A failure throws fast-check's own report: the seed, the path to replay it and the
 * shrunk counterexample. Set `FIT_SEED` to replay a seed or to pin a run; without it every run
 * uses a new seed.
 */

export interface PropertyStats { label: string; runs: number; skips: number; seed: number }

const stats: PropertyStats[] = [];

const seedFromEnvironment = (): number | undefined => {
  const value = process.env.FIT_SEED;
  return value ? Number(value) : undefined;
};

export function checkProperty<Ts extends unknown[]>(label: string, property: fc.IRawProperty<Ts, false>, numRuns = 200): PropertyStats {
  const seed = seedFromEnvironment();
  const details = fc.check(property, { numRuns, ...(seed === undefined ? {} : { seed }) });
  const entry = { label, runs: details.numRuns, skips: details.numSkips, seed: details.seed };
  stats.push(entry);
  if (details.failed) throw new Error(`Property "${label}" failed.\n${fc.defaultReportMessage(details)}`);
  return entry;
}

/** The table of properties run so far, one line each. */
export function propertyReport(): string {
  return stats.map(entry => `${String(entry.runs).padStart(5)} cases (${entry.skips} skipped, seed ${entry.seed})  ${entry.label}`).join('\n');
}

export const printPropertyReport = (title: string): void => {
  if (stats.length) console.info(`\n[properties] ${title}\n${propertyReport()}\n`);
  stats.length = 0;
};

export { fc };
