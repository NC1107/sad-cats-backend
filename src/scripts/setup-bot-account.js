/**
 * Seeds a "Claude" bot account in the database and generates a valid JWT.
 * Run inside the API container: docker exec sad-cats-api node /app/src/scripts/setup-bot-account.js
 * Outputs the JWT token to stdout.
 */
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const BOT_DISCORD_ID = '000000000000000001';
const BOT_USERNAME = 'Claude';

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // Upsert the bot account
    const result = await pool.query(`
      INSERT INTO scores (user_id, discord_id, username, score, game_state)
      VALUES (gen_random_uuid(), $1::TEXT, $2, 0, '{}')
      ON CONFLICT (discord_id) DO UPDATE SET username = $2
      RETURNING user_id
    `, [BOT_DISCORD_ID, BOT_USERNAME]);

    const userId = result.rows[0].user_id;

    // Generate JWT using the same secret as the API
    const token = jwt.sign({
      jti: uuidv4(),
      sub: BOT_DISCORD_ID,
      data: {
        userId,
        discordId: BOT_DISCORD_ID,
        username: BOT_USERNAME,
        avatarUrl: null,
        isMember: true,
      },
    }, process.env.JWT_SECRET, {
      expiresIn: '7d',
      algorithm: process.env.JWT_ALGORITHM || 'HS256',
    });

    // Output token only — no extra text
    process.stdout.write(token);
  } catch (err) {
    process.stderr.write('Error: ' + err.message + '\n');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
