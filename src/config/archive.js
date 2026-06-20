const Database = require('better-sqlite3');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../utils/logger');

const ARCHIVE_DB_SOURCE = process.env.ARCHIVE_DB_PATH || '/archive/Sad_Cat_worshipers_571556611517317120.db';

// Avoid `/tmp/discord.db` directly — `/tmp` is shared/world-writable and another process could
// pre-create or substitute the file (TOCTOU). `mkdtempSync` returns a unique 0700 directory we
// own, eliminating that attack surface (Sonar S5443).
const ARCHIVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sad-cats-archive-'));
const ARCHIVE_DB_COPY = path.join(ARCHIVE_DIR, 'discord.db');

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

// Graceful close — invoked from server.js shutdown(). Best-effort: the archive DB
// is read-only and crash-recoverable, so we never block shutdown on it.
const closeArchive = () => {
  if (archiveDb) {
    try {
      archiveDb.close();
      logger.info('Archive database closed');
    } catch (e) {
      logger.warn('Archive close failed', { error: e.message });
    }
  }
};

// Consumers use the default export AS the db and guard with `if (!archiveDb)`,
// so it must stay falsy when the archive is unavailable. Only attach closeArchive
// when the db actually connected — otherwise `module.exports` is null and setting
// a property on it throws at load time (which would crash boot for any operator
// without the archive sqlite present, defeating the catch above).
module.exports = archiveDb;
if (archiveDb) {
  module.exports.closeArchive = closeArchive;
}
