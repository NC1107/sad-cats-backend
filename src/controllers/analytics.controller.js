const {
  getUserStats,
  getUserTopChannels,
  getUserActivityHeatmap,
  getUserTimeline,
  getUserReactionStats,
  getUserFavoritePeople,
  getUserMostActiveHour,
  getUserMemberInfo,
  getUserMessageAnalysis,
  getLeaderboard,
  getServerStats,
  getEmojiLeaderboard,
  getAttachmentStats,
  getRandomAttachment,
  getChannelsWithAttachments
} = require('../models/analytics.model');
const { getOrCompute } = require('../services/cache.service');
const { getScoreByDiscordId } = require('../models/score.model');
const logger = require('../utils/logger');
const { NotFoundError } = require('../utils/errors');

const CACHE_TTL_SHORT = 300;   // 5 minutes — user profiles
const CACHE_TTL_LONG = 1800;   // 30 minutes — server dashboard, leaderboard

/**
 * Get complete user profile analytics
 * Requires authentication
 */
const getUserProfile = async (req, res, next) => {
  try {
    const { discordId } = req.params;

    // Cache user profile for 5 minutes
    const cacheKey = `analytics:user:${discordId}`;

    const profile = await getOrCompute(cacheKey, () => {
      // All SQLite queries are synchronous (better-sqlite3)
      const stats = getUserStats(discordId);

      if (!stats || stats.message_count === 0) {
        throw new NotFoundError('User not found in archive');
      }

      const topChannels = getUserTopChannels(discordId, 10);
      const activityHeatmap = getUserActivityHeatmap(discordId);
      const timeline = getUserTimeline(discordId);
      const reactionStats = getUserReactionStats(discordId);
      const favoritePeople = getUserFavoritePeople(discordId, 5);
      const mostActiveHour = getUserMostActiveHour(discordId);
      const memberInfo = getUserMemberInfo(discordId);
      const messageAnalysis = getUserMessageAnalysis(discordId);

      return {
        user: {
          id: stats.id,
          username: stats.username,
          discriminator: stats.discriminator,
          globalName: stats.global_name,
          avatar: stats.avatar
        },
        stats: {
          messageCount: stats.message_count,
          channelsUsed: stats.channels_used,
          firstMessageDate: stats.first_message_date,
          lastMessageDate: stats.last_message_date,
          mostActiveHour
        },
        memberInfo,
        messageAnalysis,
        topChannels,
        activityHeatmap,
        timeline,
        reactions: reactionStats,
        favoritePeople
      };
    });

    // Fetch game data separately (async PostgreSQL query, not cached with SQLite data)
    let gameData = null;
    try {
      const scoreRecord = await getScoreByDiscordId(discordId);
      if (scoreRecord) {
        gameData = {
          score: Number(scoreRecord.score) || 0,
          gameState: scoreRecord.game_state || null
        };
      }
    } catch (e) {
      // Game data is optional — don't fail the profile
    }
    profile.gameData = gameData;

    logger.info('User profile fetched', { discordId });

    res.json({
      success: true,
      profile
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get analytics leaderboard
 * Requires authentication
 */
const getAnalyticsLeaderboard = async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;

    const cacheKey = `analytics:leaderboard:${limit}:${offset}`;

    const leaderboard = await getOrCompute(cacheKey, () => {
      return getLeaderboard(limit, offset);
    }, CACHE_TTL_LONG);

    res.json({
      success: true,
      leaderboard,
      limit,
      offset
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get server-wide analytics dashboard
 * Requires authentication
 */
const getServerAnalytics = async (req, res, next) => {
  try {
    const cacheKey = 'analytics:server:dashboard';

    const dashboard = await getOrCompute(cacheKey, () => {
      const serverStats = getServerStats();
      const emojiLeaderboard = getEmojiLeaderboard(20);
      const attachmentStats = getAttachmentStats();

      return {
        serverStats,
        emojiLeaderboard,
        attachmentStats
      };
    }, CACHE_TTL_LONG);

    logger.info('Server analytics fetched');

    res.json({
      success: true,
      dashboard
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Check if a Discord CDN URL is expired by parsing the `ex` hex timestamp
 */
const isDiscordUrlExpired = (url) => {
  try {
    const parsed = new URL(url);
    const ex = parsed.searchParams.get('ex');
    if (!ex) return true; // No expiry param = old URL format, likely expired
    const expiryTimestamp = parseInt(ex, 16);
    return Date.now() / 1000 > expiryTimestamp;
  } catch {
    return true;
  }
};

/**
 * Refresh a Discord CDN URL by fetching the message from Discord API
 */
const refreshDiscordUrl = async (channelId, messageId, filename) => {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return null;

  try {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      { headers: { Authorization: `Bot ${botToken}` } }
    );

    if (!response.ok) return null;

    const message = await response.json();
    if (message.attachments) {
      const match = message.attachments.find(a => a.filename === filename);
      if (match) return match.url;
      // If exact filename not found, return first attachment
      if (message.attachments.length > 0) return message.attachments[0].url;
    }
    return null;
  } catch (error) {
    logger.error('Failed to refresh Discord URL', { error: error.message, channelId, messageId });
    return null;
  }
};

/**
 * Get a random attachment (image or video)
 * Requires authentication
 */
const getRandomAttachmentEndpoint = async (req, res, next) => {
  try {
    const filters = {
      mediaType: req.query.mediaType || null,
      channelId: req.query.channelId || null
    };

    const attachment = getRandomAttachment(filters);

    if (!attachment) {
      return res.json({
        success: true,
        attachment: null
      });
    }

    // Refresh expired Discord CDN URLs
    if (attachment.url && isDiscordUrlExpired(attachment.url)) {
      const freshUrl = await refreshDiscordUrl(
        attachment.channel_id,
        attachment.message_id,
        attachment.filename
      );
      if (freshUrl) {
        attachment.url = freshUrl;
      }
    }

    logger.info('Random attachment fetched', { filters });

    res.json({
      success: true,
      attachment
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get channels list for filters
 */
const getChannelsEndpoint = async (req, res, next) => {
  try {
    const channels = getChannelsWithAttachments();

    res.json({
      success: true,
      channels
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getUserProfile,
  getAnalyticsLeaderboard,
  getServerAnalytics,
  getRandomAttachmentEndpoint,
  getChannelsEndpoint
};
