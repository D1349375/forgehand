import { describe, expect, it } from 'vitest';
import { e2ePorts } from '../e2e/ports';

describe('e2ePorts', () => {
  it('uses 5197 and 8797 by default', () => {
    expect(e2ePorts({})).toEqual({ port: 5197, apiPort: 8797, localUrl: 'http://127.0.0.1:5197' });
  });

  it('accepts overrides for both ports', () => {
    expect(e2ePorts({ E2E_PORT: '6000', E2E_API_PORT: '6001' })).toEqual({
      port: 6000, apiPort: 6001, localUrl: 'http://127.0.0.1:6000',
    });
    expect(e2ePorts({ E2E_PORT: '6000' }).apiPort).toBe(8797);
    expect(e2ePorts({ E2E_API_PORT: '6001' }).port).toBe(5197);
  });

  it('rejects non-integer ports', () => {
    expect(() => e2ePorts({ E2E_PORT: 'abc' })).toThrow(Error);
    expect(() => e2ePorts({ E2E_PORT: '5197.5' })).toThrow(/E2E_PORT/);
    expect(() => e2ePorts({ E2E_API_PORT: '80a' })).toThrow(/E2E_API_PORT/);
  });

  it('rejects out-of-range ports', () => {
    expect(() => e2ePorts({ E2E_PORT: '1023' })).toThrow(/1024/);
    expect(() => e2ePorts({ E2E_PORT: '65536' })).toThrow(/65535/);
    expect(() => e2ePorts({ E2E_API_PORT: '0' })).toThrow(Error);
    expect(e2ePorts({ E2E_PORT: '1024', E2E_API_PORT: '65535' }).apiPort).toBe(65535);
  });

  it('rejects equal ports', () => {
    expect(() => e2ePorts({ E2E_PORT: '7000', E2E_API_PORT: '7000' })).toThrow(/different/);
    expect(() => e2ePorts({ E2E_PORT: '8797' })).toThrow(/different/);
  });

  it('formats localUrl from the frontend port', () => {
    expect(e2ePorts({ E2E_PORT: '7123', E2E_API_PORT: '7124' }).localUrl).toBe('http://127.0.0.1:7123');
  });
});
