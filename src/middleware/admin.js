const { AuthorizationError } = require('../utils/errors');

// Admin Discord IDs
const ADMIN_IDS = (process.env.ADMIN_DISCORD_IDS || '').split(',').filter(Boolean);

const requireAdmin = (req, res, next) => {
  const discordId = req.user?.data?.discordId || req.user?.sub;
  if (!discordId || !ADMIN_IDS.includes(discordId)) {
    return next(new AuthorizationError('Admin access required'));
  }
  next();
};

module.exports = { requireAdmin, ADMIN_IDS };
