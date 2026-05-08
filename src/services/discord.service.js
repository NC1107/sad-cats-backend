const logger = require('../utils/logger');
const { InternalError } = require('../utils/errors');
const archiveDb = require('../config/archive');

const DISCORD_API_URL = process.env.DISCORD_API_URL || 'https://discord.com/api/v10';
const DISCORD_SERVER_ID = process.env.DISCORD_SERVER_ID;

/**
 * Check if user exists in archive database (fallback for guild membership)
 * @param {string} discordId - Discord user ID
 * @returns {boolean} True if user exists in archive
 */
const checkArchiveMembership = (discordId) => {
  if (!archiveDb) {
    logger.warn('Archive database not available for membership check');
    return false;
  }

  try {
    const stmt = archiveDb.prepare('SELECT COUNT(*) as count FROM users WHERE id = ?');
    const result = stmt.get(discordId);
    const isMember = result && result.count > 0;

    logger.info('Archive membership check', { discordId, isMember });
    return isMember;
  } catch (error) {
    logger.error('Error checking archive membership', { error: error.message, discordId });
    return false;
  }
};

/**
 * Verify if user is a member of the Discord server
 * @param {string} accessToken - Discord OAuth access token
 * @param {string} discordId - Discord user ID for fallback check
 * @returns {Promise<boolean>} True if user is a member
 */
const verifyGuildMembership = async (accessToken, discordId) => {
  if (!DISCORD_SERVER_ID) {
    logger.warn('DISCORD_SERVER_ID not configured, skipping guild verification');
    return false;
  }

  // Primary check: Archive database (fast, no rate limits)
  const archiveMember = checkArchiveMembership(discordId);
  if (archiveMember) {
    logger.info('User verified via archive database', { discordId });
    return true;
  }

  // Fallback: Discord API (rate limited, may fail)
  try {
    const response = await fetch(`${DISCORD_API_URL}/users/@me/guilds`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      logger.warn('Discord API guild check failed, using archive fallback', {
        status: response.status,
        discordId
      });
      // If API fails, trust that auth worked = they're a member
      return true;
    }

    const guilds = await response.json();
    const guildIds = guilds.map(g => g.id);
    const isMember = guilds.some(guild => guild.id === DISCORD_SERVER_ID);

    logger.info('Guild membership verified via Discord API', {
      isMember,
      targetServerId: DISCORD_SERVER_ID,
      userGuilds: guildIds,
      guildCount: guilds.length
    });
    return isMember;
  } catch (error) {
    logger.error('Error verifying guild membership, defaulting to true', { error: error.message });
    // If verification fails, default to true (they authenticated via Discord OAuth)
    return true;
  }
};

/**
 * Get user information from Discord
 * @param {string} accessToken - Discord OAuth access token
 * @returns {Promise<Object>} User information
 */
const getUserInfo = async (accessToken) => {
  try {
    const response = await fetch(`${DISCORD_API_URL}/users/@me`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new InternalError('Failed to fetch user info from Discord');
    }

    const user = await response.json();
    logger.info('User info retrieved from Discord', { userId: user.id });

    return {
      discordId: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
      avatarUrl: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(user.discriminator) % 5}.png`
    };
  } catch (error) {
    logger.error('Error fetching user info', { error: error.message });
    throw error;
  }
};

module.exports = {
  verifyGuildMembership,
  getUserInfo
};
