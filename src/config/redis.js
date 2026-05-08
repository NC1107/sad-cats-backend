const { createClient } = require('redis');
const logger = require('../utils/logger');

const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => {
  logger.error('Redis Client Error', { error: err.message });
});

redisClient.on('connect', () => {
  logger.info('Redis client connected');
});

redisClient.on('ready', () => {
  logger.info('Redis client ready');
});

// Connect to Redis
const connectRedis = async () => {
  try {
    await redisClient.connect();
    logger.info('Redis connection established');
  } catch (error) {
    logger.error('Failed to connect to Redis', { error: error.message });
    throw error;
  }
};

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Closing Redis connection');
  await redisClient.quit();
});

process.on('SIGTERM', async () => {
  logger.info('Closing Redis connection');
  await redisClient.quit();
});

module.exports = {
  redisClient,
  connectRedis
};
