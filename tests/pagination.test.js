const { parsePagination } = require('../src/utils/pagination');

const req = (q) => ({ query: q });

describe('parsePagination', () => {
  test('defaults to limit=50 / offset=0 when missing', () => {
    expect(parsePagination(req({}))).toEqual({ limit: 50, offset: 0 });
  });

  test('parses numeric strings from req.query', () => {
    expect(parsePagination(req({ limit: '25', offset: '10' }))).toEqual({ limit: 25, offset: 10 });
  });

  test('clamps limit at maxLimit', () => {
    expect(parsePagination(req({ limit: '99999' }), { maxLimit: 100 })).toEqual({ limit: 100, offset: 0 });
  });

  test('rejects negative and non-numeric input, falling back to defaults', () => {
    expect(parsePagination(req({ limit: '-1' }))).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination(req({ limit: 'abc', offset: 'NaN' }))).toEqual({ limit: 50, offset: 0 });
  });

  test('honors per-call defaults', () => {
    expect(parsePagination(req({}), { defaultLimit: 15, maxLimit: 50 })).toEqual({ limit: 15, offset: 0 });
  });

  test('safe when req or query is undefined', () => {
    expect(parsePagination(undefined)).toEqual({ limit: 50, offset: 0 });
    expect(parsePagination({})).toEqual({ limit: 50, offset: 0 });
  });
});
