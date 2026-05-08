const { ZodError } = require('zod');
const { ValidationError } = require('../utils/errors');

/**
 * Middleware to validate request using Zod schema
 * @param {ZodSchema} schema - Zod schema to validate against
 */
const validateRequest = (schema) => {
  return async (req, res, next) => {
    try {
      await schema.parseAsync({
        body: req.body,
        query: req.query,
        params: req.params
      });
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
