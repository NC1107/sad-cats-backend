// Discord OAuth URL builder — extracted so the template literal isn't duplicated
// between routes/auth.routes.js (server-side redirect) and controllers/auth.controller.js
// (JSON URL response). Drift between them would silently change OAuth behavior for
// one flow without the other.

const DISCORD_OAUTH_BASE = 'https://discord.com/api/oauth2/authorize';
const DEFAULT_SCOPES = 'identify guilds';

/**
 * Build the Discord OAuth authorization URL.
 *
 * @param {object} [opts]
 * @param {string} [opts.state]  Optional CSRF state (see backend issue #10).
 * @param {string} [opts.scope]  Space-separated OAuth scopes. Defaults to `identify guilds`.
 * @returns {string} Full authorization URL
 */
const buildDiscordAuthUrl = ({ state, scope = DEFAULT_SCOPES } = {}) => {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    redirect_uri: process.env.DISCORD_CALLBACK_URL,
    response_type: 'code',
    scope,
  });
  if (state) params.set('state', state);
  return `${DISCORD_OAUTH_BASE}?${params.toString()}`;
};

module.exports = { buildDiscordAuthUrl };
