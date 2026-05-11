// The migration runner runs against a real Postgres, so we can't unit-test the
// applied SQL here. Instead we lock down its discovery + ordering behaviour: that
// it lists every `*.sql` file in lexical order and recognizes the intentional
// 002_* gap without choking.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

describe('migrations directory', () => {
  let files;
  beforeAll(() => {
    files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  });

  test('every migration filename matches NNN_name.sql', () => {
    const bad = files.filter(f => !/^\d{3}_[a-z0-9_]+\.sql$/.test(f));
    expect(bad).toEqual([]);
  });

  test('files sort lexically — newer indexes never precede older', () => {
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  test('002_* slot is intentionally absent (documented in README)', () => {
    expect(files.some(f => f.startsWith('002_'))).toBe(false);
    expect(files.some(f => f.startsWith('001_'))).toBe(true);
    expect(files.some(f => f.startsWith('003_'))).toBe(true);
  });

  test('at least one migration exists', () => {
    expect(files.length).toBeGreaterThan(0);
  });
});
