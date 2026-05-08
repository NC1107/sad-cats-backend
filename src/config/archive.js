const Database = require('better-sqlite3');
const fs = require('fs');
const logger = require('../utils/logger');

const ARCHIVE_DB_SOURCE = process.env.ARCHIVE_DB_PATH || '/archive/Sad_Cat_worshipers_571556611517317120.db';
const ARCHIVE_DB_COPY = '/tmp/discord.db';

// Initialize SQLite connection
let archiveDb = null;

try {
  // Copy database to writable location (better-sqlite3 needs temp files)
  if (!fs.existsSync(ARCHIVE_DB_COPY)) {
    logger.info('Copying archive database to temp location...');
    fs.copyFileSync(ARCHIVE_DB_SOURCE, ARCHIVE_DB_COPY);
  }

  archiveDb = new Database(ARCHIVE_DB_COPY, {
    readonly: true
  });

  // Performance optimizations
  archiveDb.pragma('cache_size = -200000'); // 200MB — cache entire DB in memory
  archiveDb.pragma('temp_store = MEMORY');

  logger.info('Archive database connected', {
    source: ARCHIVE_DB_SOURCE,
    copy: ARCHIVE_DB_COPY
  });
} catch (error) {
  logger.error('Failed to connect to archive database', {
    error: error.message,
    source: ARCHIVE_DB_SOURCE
  });
  // Don't crash the server if archive DB is unavailable
}

// Graceful shutdown
process.on('SIGINT', () => {
  if (archiveDb) {
    archiveDb.close();
    logger.info('Archive database closed');
  }
});

process.on('SIGTERM', () => {
  if (archiveDb) {
    archiveDb.close();
    logger.info('Archive database closed');
  }
});

module.exports = archiveDb;
