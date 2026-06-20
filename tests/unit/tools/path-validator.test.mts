import { describe, it, expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { validatePath } from '../../../src/tools/path-validator.mts';

// Use a real absolute path rooted at cwd so Windows drive letters are correct.
const WORKING_DIR = resolve(process.cwd(), 'test-sandbox');

describe('validatePath', () => {
  describe('valid paths', () => {
    it('accepts a simple relative filename', () => {
      const result = validatePath('file.mts', WORKING_DIR);
      expect(result).toBe(join(WORKING_DIR, 'file.mts'));
    });

    it('accepts a nested relative path', () => {
      const result = validatePath('src/services/store.mts', WORKING_DIR);
      expect(result).toBe(join(WORKING_DIR, 'src', 'services', 'store.mts'));
    });

    it('accepts an absolute path inside the working directory', () => {
      const inside = join(WORKING_DIR, 'src', 'index.mts');
      const result = validatePath(inside, WORKING_DIR);
      expect(result).toBe(inside);
    });

    it('accepts the working directory itself', () => {
      const result = validatePath(WORKING_DIR, WORKING_DIR);
      expect(result).toBe(WORKING_DIR);
    });

    it('normalises redundant segments that stay inside the directory', () => {
      const result = validatePath('src/../src/types/task.mts', WORKING_DIR);
      expect(result).toBe(join(WORKING_DIR, 'src', 'types', 'task.mts'));
    });
  });

  describe('path traversal — should throw', () => {
    it('rejects a simple parent traversal', () => {
      expect(() => validatePath('../outside.mts', WORKING_DIR)).toThrow(
        "Path '../outside.mts' is outside the working directory",
      );
    });

    it('rejects a deeply nested traversal that escapes', () => {
      expect(() => validatePath('src/../../etc/passwd', WORKING_DIR)).toThrow();
    });

    it('rejects a path with multiple traversal segments', () => {
      expect(() => validatePath('a/b/../../../escape', WORKING_DIR)).toThrow();
    });

    it('throws an Error instance', () => {
      expect(() => validatePath('../x', WORKING_DIR)).toThrow(Error);
    });
  });
});
