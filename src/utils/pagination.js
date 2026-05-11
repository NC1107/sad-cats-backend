// Pagination query-string parser. Replaces the repeated
// `Math.min(parseInt(req.query.limit) || N, MAX)` lozenges across controllers
// — different defaults and caps were inlined per endpoint, easy to silently set
// the wrong ceiling on a copy-paste.
//
// Caller passes the endpoint's intended defaults and max; the helper takes care
// of the parse, fallback, and clamp.

const DEFAULT_OPTS = { defaultLimit: 50, maxLimit: 100, defaultOffset: 0 };

/**
 * @param {object} req  Express request (uses `req.query.limit` / `req.query.offset`)
 * @param {object} [opts]
 * @param {number} [opts.defaultLimit=50]
 * @param {number} [opts.maxLimit=100]
 * @param {number} [opts.defaultOffset=0]
 * @returns {{ limit: number, offset: number }}
 */
function parsePagination(req, opts = {}) {
  const { defaultLimit, maxLimit, defaultOffset } = { ...DEFAULT_OPTS, ...opts };
  const rawLimit = parseInt(req?.query?.limit, 10);
  const rawOffset = parseInt(req?.query?.offset, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, maxLimit)
    : defaultLimit;
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0
    ? rawOffset
    : defaultOffset;
  return { limit, offset };
}

module.exports = { parsePagination };
