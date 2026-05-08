const { getTopScores } = require('../../models/score.model');
const logger = require('../../utils/logger');

// Track online users by discord_id → Set of socket IDs
const onlineUsers = new Map();

/**
 * Get list of currently online discord_ids
 */
const getOnlineUserIds = () => Array.from(onlineUsers.keys());

/**
 * Handle leaderboard socket events
 * @param {Socket} socket - Socket.IO socket instance
 * @param {Server} io - Socket.IO server instance
 * @param {Object} helpers - { getRecentActivity }
 */
const handleLeaderboardEvents = (socket, io, { getRecentActivity }) => {
  // Subscribe to leaderboard updates
  socket.on('subscribe:leaderboard', async () => {
    try {
      // Join the leaderboard room
      socket.join('leaderboard');

      logger.info('Client subscribed to leaderboard', { socketId: socket.id });

      // Track online user
      const discordId = socket.user?.data?.discordId || socket.user?.sub;
      if (discordId) {
        if (!onlineUsers.has(discordId)) {
          onlineUsers.set(discordId, new Set());
        }
        onlineUsers.get(discordId).add(socket.id);
        // Broadcast updated online list to all in leaderboard room
        io.to('leaderboard').emit('online:users', getOnlineUserIds());
      }

      // Send initial leaderboard data
      const scores = await getTopScores(50);
      socket.emit('leaderboard:full', {
        type: 'leaderboard_full',
        scores
      });

      // Send current online users to this socket
      socket.emit('online:users', getOnlineUserIds());

      // Send recent activity history
      const history = await getRecentActivity(50);
      if (history.length > 0) {
        socket.emit('activity:history', history);
      }
    } catch (error) {
      logger.error('Error subscribing to leaderboard', {
        error: error.message,
        socketId: socket.id
      });
      socket.emit('error', {
        message: 'Failed to subscribe to leaderboard'
      });
    }
  });

  // Unsubscribe from leaderboard updates
  socket.on('unsubscribe:leaderboard', () => {
    socket.leave('leaderboard');
    removeOnlineUser(socket, io);
    logger.info('Client unsubscribed from leaderboard', { socketId: socket.id });
  });

  // Handle disconnect
  socket.on('disconnect', (reason) => {
    removeOnlineUser(socket, io);
    logger.info('Client disconnected', { socketId: socket.id, reason });
  });
};

/**
 * Remove a socket from online tracking and broadcast update
 */
const removeOnlineUser = (socket, io) => {
  const discordId = socket.user?.data?.discordId || socket.user?.sub;
  if (discordId && onlineUsers.has(discordId)) {
    onlineUsers.get(discordId).delete(socket.id);
    if (onlineUsers.get(discordId).size === 0) {
      onlineUsers.delete(discordId);
    }
    io.to('leaderboard').emit('online:users', getOnlineUserIds());
  }
};

// Garbage-collect empty entries from onlineUsers every 5 minutes
const gcInterval = setInterval(() => {
  for (const [discordId, sockets] of onlineUsers) {
    if (sockets.size === 0) {
      onlineUsers.delete(discordId);
    }
  }
}, 5 * 60 * 1000);

const cleanupOnlineTracking = () => {
  clearInterval(gcInterval);
  onlineUsers.clear();
};

const getOnlineCount = () => onlineUsers.size;

module.exports = {
  handleLeaderboardEvents,
  cleanupOnlineTracking,
  getOnlineCount,
};
