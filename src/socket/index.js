const { Server } = require('socket.io');
const { Pool } = require('pg');
const { verifyToken } = require('../services/jwt.service');
const { handleLeaderboardEvents } = require('./handlers/leaderboard.handler');
const { handleChatEvents } = require('./handlers/chat.handler');
const { redisClient } = require('../config/redis');
const logger = require('../utils/logger');

const ACTIVITY_KEY = 'activity:log';
const ACTIVITY_MAX = 50;

// Track LISTEN pool for graceful shutdown
let listenerPool = null;

/**
 * Push an activity entry to Redis and broadcast to leaderboard room.
 * Entry shape: { type, icon, message, username?, time }
 */
const pushActivity = async (entry) => {
  try {
    const item = JSON.stringify({ ...entry, time: entry.time || Date.now() });
    await redisClient.lPush(ACTIVITY_KEY, item);
    await redisClient.lTrim(ACTIVITY_KEY, 0, ACTIVITY_MAX - 1);
  } catch (e) {
    logger.warn('Failed to push activity to Redis', { error: e.message });
  }
};

/**
 * Get recent activity entries from Redis (newest first).
 */
const getRecentActivity = async (count = ACTIVITY_MAX) => {
  try {
    const raw = await redisClient.lRange(ACTIVITY_KEY, 0, count - 1);
    return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    logger.warn('Failed to read activity from Redis', { error: e.message });
    return [];
  }
};

let io = null;

/**
 * Initialize Socket.IO server
 * @param {http.Server} httpServer - HTTP server instance
 * @returns {Server} Socket.IO server instance
 */
const initializeSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || 'https://sad-cats.org',
      methods: ['GET', 'POST'],
      credentials: true
    },
    pingInterval: parseInt(process.env.WS_PING_INTERVAL) || 25000,
    pingTimeout: parseInt(process.env.WS_PING_TIMEOUT) || 5000,
    transports: ['websocket', 'polling']
  });

  // Authentication middleware for Socket.IO
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (token) {
        // Verify JWT token
        const decoded = await verifyToken(token);
        socket.user = decoded;
        logger.info('Socket authenticated', { socketId: socket.id, discordId: decoded.sub });
      }

      next();
    } catch (error) {
      logger.warn('Socket authentication failed', { error: error.message });
      // Allow connection even if auth fails (for public leaderboard)
      next();
    }
  });

  // Handle connections
  io.on('connection', (socket) => {
    logger.info('New socket connection', {
      socketId: socket.id,
      authenticated: !!socket.user
    });

    // Register event handlers
    handleLeaderboardEvents(socket, io, { getRecentActivity });
    handleChatEvents(socket, io, { pushActivity });

    // Achievement broadcast from authenticated clients
    socket.on('activity:achievement', (data) => {
      if (!socket.user || !data.name) return;
      const entry = {
        type: 'achievement',
        username: data.username,
        message: `${data.username} unlocked ${data.name}`,
        icon: data.icon || '🏆',
        time: Date.now()
      };
      io.to('leaderboard').emit('activity', entry);
      pushActivity(entry);
    });
  });

  // Setup PostgreSQL NOTIFY/LISTEN for real-time updates
  setupPostgresListener();

  logger.info('Socket.IO server initialized');
  return io;
};

/**
 * Setup PostgreSQL NOTIFY/LISTEN for score updates with auto-reconnect
 */
const setupPostgresListener = () => {
  let reconnectDelay = 1000;
  const MAX_DELAY = 30000;

  const connect = () => {
    listenerPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1
    });

    listenerPool.connect((err, client, release) => {
      if (err) {
        logger.error('Error connecting to PostgreSQL for LISTEN, retrying...', { error: err.message, retryMs: reconnectDelay });
        listenerPool.end().catch(() => {});
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
        return;
      }

      logger.info('PostgreSQL LISTEN connection established');
      reconnectDelay = 1000; // reset on success

      client.query('LISTEN score_updated');

      client.on('notification', (msg) => {
        try {
          if (msg.channel === 'score_updated') {
            const score = JSON.parse(msg.payload);

            logger.info('Score update notification received', {
              discordId: score.discord_id,
              score: score.score
            });

            if (io) {
              io.to('leaderboard').emit('leaderboard:update', {
                type: 'score_updated',
                score: {
                  discord_id: score.discord_id,
                  username: score.username,
                  avatar_url: score.avatar_url,
                  score: typeof score.score === 'string' ? parseInt(score.score, 10) : score.score,
                  updated_at: score.updated_at,
                  game_state: score.game_state
                }
              });
            }
          }
        } catch (error) {
          logger.error('Error processing PostgreSQL notification', { error: error.message });
        }
      });

      client.on('error', (err) => {
        logger.error('PostgreSQL LISTEN client error, reconnecting...', { error: err.message });
        release(err);
        listenerPool.end().catch(() => {});
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      });

      client.on('end', () => {
        logger.warn('PostgreSQL LISTEN connection ended, reconnecting...');
        listenerPool.end().catch(() => {});
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
      });
    });
  };

  connect();
};

/**
 * Get Socket.IO server instance
 * @returns {Server|null}
 */
const getIO = () => {
  if (!io) {
    logger.warn('Socket.IO server not initialized');
  }
  return io;
};

/**
 * Close Socket.IO and LISTEN pool for graceful shutdown
 */
const closeSocket = async () => {
  if (io) {
    io.disconnectSockets(true);
    io.close();
    logger.info('Socket.IO closed');
  }
  if (listenerPool) {
    await listenerPool.end().catch(() => {});
    logger.info('PostgreSQL LISTEN pool closed');
  }
};

module.exports = {
  initializeSocket,
  getIO,
  pushActivity,
  getRecentActivity,
  closeSocket
};
