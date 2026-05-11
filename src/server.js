require('dotenv').config();
// Validate env BEFORE anything else imports + reads process.env — crashes loudly
// on missing required keys instead of 500-ing the first request that touches them.
require('./config/env').validateEnv();

const http = require('http');
const app = require('./app');
const { connectRedis } = require('./config/redis');
const { initializeSocket } = require('./socket/index');
const pool = require('./config/database');
const logger = require('./utils/logger');

const PORT = process.env.PORT || 3001;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = initializeSocket(server);

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = './logs';
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Start the server
 */
const startServer = async () => {
  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    logger.info('Database connection established');

    // Connect to Redis
    await connectRedis();

    // Start server
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server started successfully`, {
        port: PORT,
        environment: NODE_ENV,
        pid: process.pid
      });

      logger.info(`API available at http://localhost:${PORT}/api`);
      logger.info(`Health check: http://localhost:${PORT}/api/health`);
      logger.info(`WebSocket server running on port ${PORT}`);

      // Surge spawn check every 30 minutes
      const { checkSurgeSpawn } = require('./models/boss.model');
      const { getOnlineCount } = require('./socket/handlers/leaderboard.handler');
      setInterval(() => {
        const count = getOnlineCount();
        if (count >= 3) {
          checkSurgeSpawn(count).catch(err =>
            logger.error('Surge spawn check failed', { error: err.message })
          );
        }
      }, 30 * 60 * 1000);
    });
  } catch (error) {
    logger.error('Failed to start server', { error: error.message });
    process.exit(1);
  }
};

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection', { reason, promise });
  process.exit(1);
});

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down gracefully`);

  // Disconnect all sockets and close LISTEN pool first
  try {
    const { closeSocket } = require('./socket/index');
    await closeSocket();
    const { cleanupOnlineTracking } = require('./socket/handlers/leaderboard.handler');
    cleanupOnlineTracking();
  } catch (e) {
    logger.warn('Error closing sockets', { error: e.message });
  }

  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      // Close DB / Redis / archive — each module exposes a close fn, no longer
      // registers its own SIGINT/SIGTERM handler. Order: DB first (queries running
      // for in-flight requests already finished above), then Redis, then archive.
      const { closePool } = require('./config/database');
      await closePool();
      logger.info('Database pool closed');

      const { closeRedis } = require('./config/redis');
      await closeRedis();
      logger.info('Redis connection closed');

      const { closeArchive } = require('./config/archive');
      closeArchive();

      logger.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', { error: error.message });
      process.exit(1);
    }
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start the server
startServer();
