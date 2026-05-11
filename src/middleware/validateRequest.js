const { ZodError } = require('zod');
const { ValidationError } = require('../utils/errors');

/**
 * Middleware to validate request using Zod schema.
 *
 * The parsed result is assigned back to `req` so handlers see defaults applied,
 * transforms resolved, and unknown fields stripped (when the schema is strict).
 * Without this assignment the schema was decorative — handlers read raw req.body
 * and zod defaults / .strip() never took effect.
 *
 * @param {ZodSchema} schema - Zod schema to validate against
 */
const validateRequest = (schema) => {
  return async (req, res, next) => {
    try {
      const parsed = await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params
      });
      if (parsed?.body !== undefined) req.body = parsed.body;
      if (parsed?.query !== undefined) req.query = parsed.query;
      if (parsed?.params !== undefined) req.params = parsed.params;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(error);
      } else {
        next(new ValidationError('Invalid request data'));
      }
    }
  };
};

module.exports = {
  validateRequest
};
