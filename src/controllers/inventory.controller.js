const inventoryModel = require('../models/inventory.model');
const logger = require('../utils/logger');

/**
 * Get authenticated user's toy inventory + counts
 */
const getMyToys = async (req, res, next) => {
  try {
    const discordId = req.user.data.discordId;
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const offset = parseInt(req.query.offset) || 0;

    const [toys, counts] = await Promise.all([
      inventoryModel.getToys(discordId, { limit, offset }),
      inventoryModel.getToyCounts(discordId),
    ]);

    const total = counts.reduce((sum, c) => sum + c.count, 0);

    res.json({
      success: true,
      toys,
      counts,
      total,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMyToys,
};
