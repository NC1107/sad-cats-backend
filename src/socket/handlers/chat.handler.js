const logger = require('../../utils/logger');

const rateLimits = new Map(); // discordId → lastMessageTime

const handleChatEvents = (socket, io, { pushActivity }) => {
  socket.on('chat:send', (data) => {
    if (!socket.user) return; // auth required
    const discordId = socket.user.sub || socket.user.data?.discordId;
    const username = data.username;
    if (!data.message || typeof data.message !== 'string') return;
    const message = data.message.trim().slice(0, 200); // max 200 chars
    if (!message) return;

    // Rate limit: 1 msg per 2 seconds
    const now = Date.now();
    const last = rateLimits.get(discordId) || 0;
    if (now - last < 2000) return;
    rateLimits.set(discordId, now);

    logger.info('Chat message', { discordId, username, message: message.slice(0, 50) });

    io.to('leaderboard').emit('chat:message', {
      username, message, discordId, time: now
    });

    pushActivity({
      type: 'chat',
      icon: '💬',
      message: `${username}: ${message}`,
      username,
      time: now
    });
  });
};

module.exports = { handleChatEvents };
