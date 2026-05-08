const archiveDb = require('../config/archive');
const logger = require('../utils/logger');
const { InternalError, NotFoundError } = require('../utils/errors');

// Blacklist of NSFW or inappropriate emoji names to filter out
const EMOJI_BLACKLIST = ['critjob', 'ctitjob', 'titjob'];

// Check if archive DB is available
const isAvailable = () => {
  if (!archiveDb) {
    throw new InternalError('Archive database not available');
  }
  return true;
};

/**
 * Get user profile stats
 */
const getUserStats = (discordId) => {
  isAvailable();

  try {
    const stmt = archiveDb.prepare(`
      SELECT
        CAST(u.id AS TEXT) as id,
        u.username,
        u.discriminator,
        u.global_name,
        u.avatar,
        COUNT(DISTINCT m.id) as message_count,
        COUNT(DISTINCT m.channel_id) as channels_used,
        MIN(m.created_at) as first_message_date,
        MAX(m.created_at) as last_message_date
      FROM users u
      LEFT JOIN messages m ON u.id = m.author_id
      WHERE u.id = CAST(? AS INTEGER)
      GROUP BY u.id
    `);

    return stmt.get(String(discordId));
  } catch (error) {
    logger.error('Error fetching user stats', { error: error.message, discordId });
    throw new InternalError('Failed to fetch user statistics');
  }
};

/**
 * Get user's top channels (by message count)
 */
const getUserTopChannels = (discordId, limit = 10) => {
  isAvailable();

  try {
    const stmt = archiveDb.prepare(`
      SELECT
        CAST(c.id AS TEXT) as id,
        c.name,
        c.type,
        COUNT(m.id) as message_count,
        MAX(m.created_at) as last_message_date
      FROM messages m
      JOIN channels c ON m.channel_id = c.id
      WHERE m.author_id = CAST(? AS INTEGER)
      GROUP BY c.id, c.name, c.type
      ORDER BY message_count DESC
      LIMIT ?
    `);

    return stmt.all(String(discordId), limit);
  } catch (error) {
    logger.error('Error fetching user top channels', { error: error.message, discordId });
    throw new InternalError('Failed to fetch top channels');
  }
};

/**
 * Get user's activity heatmap (messages by hour and day of week)
 */
const getUserActivityHeatmap = (discordId) => {
  isAvailable();

  try {
    const stmt = archiveDb.prepare(`
      SELECT
        CAST(strftime('%w', created_at) AS INTEGER) as day_of_week,
        CAST(strftime('%H', created_at) AS INTEGER) as hour_of_day,
        COUNT(*) as message_count
      FROM messages
      WHERE author_id = CAST(? AS INTEGER)
      GROUP BY day_of_week, hour_of_day
      ORDER BY day_of_week, hour_of_day
    `);

    return stmt.all(String(discordId));
  } catch (error) {
    logger.error('Error fetching activity heatmap', { error: error.message, discordId });
    throw new InternalError('Failed to fetch activity heatmap');
  }
};

/**
 * Get user's message timeline (messages per month)
 */
const getUserTimeline = (discordId) => {
  isAvailable();

  try {
    const stmt = archiveDb.prepare(`
      SELECT
        strftime('%Y-%m', created_at) as month,
        COUNT(*) as message_count
      FROM messages
      WHERE author_id = CAST(? AS INTEGER)
      GROUP BY month
      ORDER BY month ASC
    `);

    return stmt.all(String(discordId));
  } catch (error) {
    logger.error('Error fetching user timeline', { error: error.message, discordId });
    throw new InternalError('Failed to fetch user timeline');
  }
};

/**
 * Get user's reaction statistics (received on their messages)
 */
const getUserReactionStats = (discordId) => {
  isAvailable();

  try {
    // Reactions received on user's messages
    const placeholders = EMOJI_BLACKLIST.map(() => '?').join(',');
    const receivedStmt = archiveDb.prepare(`
      SELECT
        r.emoji_name,
        CAST(r.emoji_id AS TEXT) as emoji_id,
        COALESCE(r.emoji_animated, 0) as emoji_animated,
        SUM(r.count) as total_count
      FROM reactions r
      JOIN messages m ON r.message_id = m.id
      WHERE m.author_id = CAST(? AS INTEGER)
        AND LOWER(r.emoji_name) NOT IN (${placeholders})
      GROUP BY r.emoji_name, r.emoji_id, r.emoji_animated
      ORDER BY total_count DESC
      LIMIT 10
    `);

    const received = receivedStmt.all(String(discordId), ...EMOJI_BLACKLIST);

    return {
      received,
      totalReceived: received.reduce((sum, r) => sum + r.total_count, 0)
    };
  } catch (error) {
    logger.error('Error fetching reaction stats', { error: error.message, discordId });
    throw new InternalError('Failed to fetch reaction statistics');
  }
};

/**
 * Get user's most mentioned users (favorite people they ping)
 */
const getUserFavoritePeople = (discordId, limit = 5) => {
  isAvailable();

  try {
    const stmt = archiveDb.prepare(`
      SELECT
        CAST(mm.user_id AS TEXT) as user_id,
        u.username,
        u.discriminator,
        u.avatar,
        COUNT(*) as mention_count
      FROM message_mentions mm
      JOIN messages m ON mm.message_id = m.id
      LEFT JOIN users u ON mm.user_id = u.id
      WHERE m.author_id = CAST(? AS INTEGER)
      GROUP BY mm.user_id
      ORDER BY mention_count DESC
      LIMIT ?
    `);

    return stmt.all(String(discordId), limit);
  } catch (error) {
    logger.error('Error fetching favorite people', { error: error.message, discordId });
    throw new InternalError('Failed to fetch favorite people');
  }
};

/**
 * Get user's most active hour of the day
 */
const getUserMostActiveHour = (discordId) => {
  isAvailable();

  try {
    const stmt = archiveDb.prepare(`
      SELECT
        CAST(strftime('%H', created_at) AS INTEGER) as hour,
        COUNT(*) as message_count
      FROM messages
      WHERE author_id = CAST(? AS INTEGER)
      GROUP BY hour
      ORDER BY message_count DESC
      LIMIT 1
    `);

    const result = stmt.get(String(discordId));
    return result ? result.hour : null;
  } catch (error) {
    logger.error('Error fetching most active hour', { error: error.message, discordId });
    throw new InternalError('Failed to fetch most active hour');
  }
};

/**
 * Get user's member info (join date, roles)
 */
const getUserMemberInfo = (discordId) => {
  isAvailable();

  try {
    // Get member join date
    const memberStmt = archiveDb.prepare(`
      SELECT
        joined_at,
        nickname,
        premium_since
      FROM members
      WHERE user_id = CAST(? AS INTEGER)
      LIMIT 1
    `);
    const memberInfo = memberStmt.get(String(discordId));

    // Get user's roles
    const rolesStmt = archiveDb.prepare(`
      SELECT
        r.name,
        r.color,
        r.position,
        CAST(r.id AS TEXT) as role_id
      FROM member_roles mr
      JOIN members m ON mr.member_id = m.id
      JOIN roles r ON mr.role_id = r.id
      WHERE m.user_id = CAST(? AS INTEGER)
      ORDER BY r.position DESC
    `);
    const roles = rolesStmt.all(String(discordId));

    return {
      joinedAt: memberInfo?.joined_at || null,
      nickname: memberInfo?.nickname || null,
      premiumSince: memberInfo?.premium_since || null,
      roles: roles.filter(r => r.name !== '@everyone') // Exclude @everyone role
    };
  } catch (error) {
    logger.error('Error fetching member info', { error: error.message, discordId });
    // Return null if user not in members table (may have left server)
    return { joinedAt: null, nickname: null, premiumSince: null, roles: [] };
  }
};

/**
 * Get user's message content analysis
 */
const getUserMessageAnalysis = (discordId) => {
  isAvailable();

  try {
    // Basic message stats
    const basicStmt = archiveDb.prepare(`
      SELECT
        COUNT(*) as total_messages,
        AVG(LENGTH(content)) as avg_message_length,
        SUM(LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) + 1) as total_words,
        SUM(CASE WHEN content LIKE '%?%' THEN 1 ELSE 0 END) as question_count,
        SUM(CASE WHEN content LIKE '%!%' THEN 1 ELSE 0 END) as exclamation_count,
        SUM(CASE WHEN content LIKE '%http%' THEN 1 ELSE 0 END) as link_count,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM messages
      WHERE author_id = CAST(? AS INTEGER)
        AND LENGTH(TRIM(content)) > 0
    `);
    const basic = basicStmt.get(String(discordId));

    // Night owl calculation (messages between 22:00-06:00)
    const nightStmt = archiveDb.prepare(`
      SELECT
        COUNT(*) as night_messages
      FROM messages
      WHERE author_id = CAST(? AS INTEGER)
        AND (CAST(strftime('%H', created_at) AS INTEGER) >= 22 OR CAST(strftime('%H', created_at) AS INTEGER) < 6)
    `);
    const night = nightStmt.get(String(discordId));

    // Weekend warrior (Sat=6, Sun=0)
    const weekendStmt = archiveDb.prepare(`
      SELECT
        COUNT(*) as weekend_messages
      FROM messages
      WHERE author_id = CAST(? AS INTEGER)
        AND CAST(strftime('%w', created_at) AS INTEGER) IN (0, 6)
    `);
    const weekend = weekendStmt.get(String(discordId));

    // Most active day of week
    const dayStmt = archiveDb.prepare(`
      SELECT
        CAST(strftime('%w', created_at) AS INTEGER) as day,
        COUNT(*) as count
      FROM messages
      WHERE author_id = CAST(? AS INTEGER)
      GROUP BY day
      ORDER BY count DESC
      LIMIT 1
    `);
    const mostActiveDay = dayStmt.get(String(discordId));

    const totalMessages = basic.total_messages || 0;
    const avgWordsPerMessage = basic.total_words / totalMessages || 0;

    return {
      avgMessageLength: Math.round(basic.avg_message_length || 0),
      totalWords: basic.total_words || 0,
      avgWordsPerMessage: Math.round(avgWordsPerMessage),
      questionFrequency: totalMessages > 0 ? ((basic.question_count / totalMessages) * 100).toFixed(1) : 0,
      exclamationFrequency: totalMessages > 0 ? ((basic.exclamation_count / totalMessages) * 100).toFixed(1) : 0,
      linkSharerFrequency: totalMessages > 0 ? ((basic.link_count / totalMessages) * 100).toFixed(1) : 0,
      nightOwlScore: totalMessages > 0 ? ((night.night_messages / totalMessages) * 100).toFixed(1) : 0,
      weekendWarrior: totalMessages > 0 ? ((weekend.weekend_messages / totalMessages) * 100).toFixed(1) : 0,
      activeDays: basic.active_days || 0,
      avgMessagesPerDay: basic.active_days > 0 ? (totalMessages / basic.active_days).toFixed(1) : 0,
      mostActiveDayOfWeek: mostActiveDay ? mostActiveDay.day : null
    };
  } catch (error) {
    logger.error('Error fetching message analysis', { error: error.message, discordId });
    throw new InternalError('Failed to fetch message analysis');
  }
};

/**
 * Get leaderboard (top users by message count)
 */
const getLeaderboard = (limit = 50, offset = 0) => {
  isAvailable();

  try {
    const stmt = archiveDb.prepare(`
      SELECT
        CAST(u.id AS TEXT) as id,
        u.username,
        u.discriminator,
        u.global_name,
        u.avatar,
        COUNT(m.id) as message_count,
        COUNT(DISTINCT m.channel_id) as channels_used
      FROM users u
      JOIN messages m ON u.id = m.author_id
      GROUP BY u.id
      ORDER BY message_count DESC
      LIMIT ? OFFSET ?
    `);

    return stmt.all(limit, offset);
  } catch (error) {
    logger.error('Error fetching leaderboard', { error: error.message });
    throw new InternalError('Failed to fetch leaderboard');
  }
};

/**
 * Get server-wide message analysis
 */
const getServerMessageAnalysis = () => {
  isAvailable();

  try {
    // Basic server message stats
    const basicStmt = archiveDb.prepare(`
      SELECT
        COUNT(*) as total_messages,
        AVG(LENGTH(content)) as avg_message_length,
        SUM(LENGTH(content) - LENGTH(REPLACE(content, ' ', '')) + 1) as total_words,
        SUM(CASE WHEN content LIKE '%?%' THEN 1 ELSE 0 END) as question_count,
        SUM(CASE WHEN content LIKE '%!%' THEN 1 ELSE 0 END) as exclamation_count,
        SUM(CASE WHEN content LIKE '%http%' THEN 1 ELSE 0 END) as link_count
      FROM messages
      WHERE LENGTH(TRIM(content)) > 0
    `);
    const basic = basicStmt.get();

    // Peak activity hour
    const peakHourStmt = archiveDb.prepare(`
      SELECT
        CAST(strftime('%H', created_at) AS INTEGER) as hour,
        COUNT(*) as message_count
      FROM messages
      GROUP BY hour
      ORDER BY message_count DESC
      LIMIT 1
    `);
    const peakHour = peakHourStmt.get();

    // Most active day of week
    const peakDayStmt = archiveDb.prepare(`
      SELECT
        CAST(strftime('%w', created_at) AS INTEGER) as day,
        COUNT(*) as count
      FROM messages
      GROUP BY day
      ORDER BY count DESC
      LIMIT 1
    `);
    const peakDay = peakDayStmt.get();

    // Night messages (10pm-6am)
    const nightStmt = archiveDb.prepare(`
      SELECT COUNT(*) as night_messages
      FROM messages
      WHERE CAST(strftime('%H', created_at) AS INTEGER) >= 22
         OR CAST(strftime('%H', created_at) AS INTEGER) < 6
    `);
    const night = nightStmt.get();

    // Weekend messages
    const weekendStmt = archiveDb.prepare(`
      SELECT COUNT(*) as weekend_messages
      FROM messages
      WHERE CAST(strftime('%w', created_at) AS INTEGER) IN (0, 6)
    `);
    const weekend = weekendStmt.get();

    const totalMessages = basic.total_messages || 0;
    const avgWordsPerMessage = basic.total_words / totalMessages || 0;

    return {
      avgMessageLength: Math.round(basic.avg_message_length || 0),
      totalWords: basic.total_words || 0,
      avgWordsPerMessage: Math.round(avgWordsPerMessage),
      questionFrequency: totalMessages > 0 ? ((basic.question_count / totalMessages) * 100).toFixed(1) : 0,
      exclamationFrequency: totalMessages > 0 ? ((basic.exclamation_count / totalMessages) * 100).toFixed(1) : 0,
      linkSharerFrequency: totalMessages > 0 ? ((basic.link_count / totalMessages) * 100).toFixed(1) : 0,
      nightOwlPercentage: totalMessages > 0 ? ((night.night_messages / totalMessages) * 100).toFixed(1) : 0,
      weekendPercentage: totalMessages > 0 ? ((weekend.weekend_messages / totalMessages) * 100).toFixed(1) : 0,
      peakActivityHour: peakHour ? peakHour.hour : null,
      peakActivityDay: peakDay ? peakDay.day : null
    };
  } catch (error) {
    logger.error('Error fetching server message analysis', { error: error.message });
    throw new InternalError('Failed to fetch server message analysis');
  }
};

/**
 * Get server statistics (for dashboard)
 */
const getServerStats = () => {
  isAvailable();

  try {
    const stats = {
      totalMessages: archiveDb.prepare('SELECT COUNT(*) as count FROM messages').get().count,
      totalUsers: archiveDb.prepare('SELECT COUNT(DISTINCT author_id) as count FROM messages').get().count,
      totalChannels: archiveDb.prepare('SELECT COUNT(*) as count FROM channels WHERE type IN (0, 2, 5)').get().count,
      dateRange: archiveDb.prepare('SELECT MIN(created_at) as first, MAX(created_at) as last FROM messages').get(),
      messagesByYear: archiveDb.prepare(`
        SELECT
          strftime('%Y', created_at) as year,
          COUNT(*) as count
        FROM messages
        GROUP BY year
        ORDER BY year
      `).all(),
      topChannels: archiveDb.prepare(`
        SELECT
          CAST(c.id AS TEXT) as id,
          c.name,
          COUNT(m.id) as message_count
        FROM channels c
        JOIN messages m ON c.id = m.channel_id
        WHERE c.type IN (0, 2, 5)
        GROUP BY c.id
        ORDER BY message_count DESC
        LIMIT 10
      `).all(),
      messageAnalysis: getServerMessageAnalysis()
    };

    return stats;
  } catch (error) {
    logger.error('Error fetching server stats', { error: error.message });
    throw new InternalError('Failed to fetch server statistics');
  }
};

/**
 * Get emoji/reaction leaderboard
 */
const getEmojiLeaderboard = (limit = 20) => {
  isAvailable();

  try {
    const placeholders = EMOJI_BLACKLIST.map(() => '?').join(',');
    const stmt = archiveDb.prepare(`
      SELECT
        emoji_name,
        CAST(emoji_id AS TEXT) as emoji_id,
        emoji_animated,
        SUM(count) as total_count
      FROM reactions
      WHERE emoji_name IS NOT NULL
        AND LOWER(emoji_name) NOT IN (${placeholders})
      GROUP BY emoji_name, emoji_id
      ORDER BY total_count DESC
      LIMIT ?
    `);

    return stmt.all(...EMOJI_BLACKLIST, limit);
  } catch (error) {
    logger.error('Error fetching emoji leaderboard', { error: error.message });
    throw new InternalError('Failed to fetch emoji leaderboard');
  }
};

/**
 * Get attachment statistics
 */
const getAttachmentStats = () => {
  isAvailable();

  try {
    const stats = {
      totalAttachments: archiveDb.prepare('SELECT COUNT(*) as count FROM attachments').get().count,
      byContentType: archiveDb.prepare(`
        SELECT
          CASE
            WHEN content_type LIKE 'image/%' THEN 'image'
            WHEN content_type LIKE 'video/%' THEN 'video'
            WHEN content_type LIKE 'audio/%' THEN 'audio'
            ELSE 'other'
          END as type,
          COUNT(*) as count
        FROM attachments
        GROUP BY type
        ORDER BY count DESC
      `).all(),
      topUploaders: archiveDb.prepare(`
        SELECT
          CAST(m.author_id AS TEXT) as author_id,
          u.username,
          COUNT(a.id) as attachment_count
        FROM attachments a
        JOIN messages m ON a.message_id = m.id
        JOIN users u ON m.author_id = u.id
        GROUP BY m.author_id
        ORDER BY attachment_count DESC
        LIMIT 10
      `).all()
    };

    return stats;
  } catch (error) {
    logger.error('Error fetching attachment stats', { error: error.message });
    throw new InternalError('Failed to fetch attachment statistics');
  }
};

/**
 * Get a random attachment with optional filters
 * @param {Object} filters - Optional filters { mediaType, channelId }
 */
const getRandomAttachment = (filters = {}) => {
  isAvailable();

  try {
    let whereConditions = [];
    let params = [];

    // Media type filter
    if (filters.mediaType) {
      whereConditions.push(`a.content_type LIKE ?`);
      params.push(`${filters.mediaType}/%`);
    } else {
      // Default: images or videos only
      whereConditions.push(`(a.content_type LIKE 'image/%' OR a.content_type LIKE 'video/%')`);
    }

    // Channel filter
    if (filters.channelId) {
      whereConditions.push(`m.channel_id = CAST(? AS INTEGER)`);
      params.push(String(filters.channelId));
    }

    const whereClause = whereConditions.length > 0
      ? `WHERE ${whereConditions.join(' AND ')}`
      : '';

    const stmt = archiveDb.prepare(`
      SELECT
        CAST(a.id AS TEXT) as id,
        a.filename,
        a.url,
        a.proxy_url,
        a.content_type,
        a.size,
        a.width,
        a.height,
        CAST(m.id AS TEXT) as message_id,
        CAST(m.author_id AS TEXT) as author_id,
        u.username,
        c.name as channel_name,
        CAST(c.id AS TEXT) as channel_id,
        m.created_at
      FROM attachments a
      JOIN messages m ON a.message_id = m.id
      JOIN users u ON m.author_id = u.id
      LEFT JOIN channels c ON m.channel_id = c.id
      ${whereClause}
      ORDER BY RANDOM()
      LIMIT 1
    `);

    return params.length > 0 ? stmt.get(...params) : stmt.get();
  } catch (error) {
    logger.error('Error fetching random attachment', { error: error.message, filters });
    throw new InternalError('Failed to fetch random attachment');
  }
};

/**
 * Get list of channels with attachments (for filter dropdown)
 */
const getChannelsWithAttachments = () => {
  isAvailable();

  try {
    const stmt = archiveDb.prepare(`
      SELECT DISTINCT
        CAST(c.id AS TEXT) as id,
        c.name,
        COUNT(a.id) as attachment_count
      FROM channels c
      JOIN messages m ON c.id = m.channel_id
      JOIN attachments a ON m.id = a.message_id
      WHERE c.type IN (0, 2, 5)
      GROUP BY c.id
      HAVING attachment_count > 10
      ORDER BY attachment_count DESC
      LIMIT 50
    `);

    return stmt.all();
  } catch (error) {
    logger.error('Error fetching channels', { error: error.message });
    throw new InternalError('Failed to fetch channels');
  }
};

module.exports = {
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
  getServerMessageAnalysis,
  getEmojiLeaderboard,
  getAttachmentStats,
  getRandomAttachment,
  getChannelsWithAttachments
};
