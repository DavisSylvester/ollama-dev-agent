import { describe, it, expect } from 'bun:test';
import { selectOdaEnv } from '../../src/env.mts';

describe('selectOdaEnv', () => {
  const oda = { CODER_MODEL: 'oda-coder', LOG_FILE: '.oda.log' };

  it("fills variables that aren't set anywhere from oda's .env", () => {
    expect(selectOdaEnv(oda, {}, {})).toEqual(oda);
  });

  it('keeps a variable set in the real environment', () => {
    const selected = selectOdaEnv(oda, {}, { CODER_MODEL: 'from-shell' });
    expect(selected).toEqual({ LOG_FILE: '.oda.log' });
  });

  it("overrides a value Bun auto-loaded from the invocation directory's .env", () => {
    const selected = selectOdaEnv(oda, { CODER_MODEL: 'stray' }, { CODER_MODEL: 'stray' });
    expect(selected['CODER_MODEL']).toBe('oda-coder');
  });

  it('keeps a real value even when the invocation directory has a different .env value', () => {
    const selected = selectOdaEnv(oda, { CODER_MODEL: 'stray' }, { CODER_MODEL: 'from-shell' });
    expect(selected['CODER_MODEL']).toBeUndefined();
  });
});
