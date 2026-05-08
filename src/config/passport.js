const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const logger = require('../utils/logger');

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_CALLBACK_URL = process.env.DISCORD_CALLBACK_URL;

// Configure Discord OAuth strategy
passport.use(new DiscordStrategy({
    clientID: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    callbackURL: DISCORD_CALLBACK_URL,
    scope: ['identify', 'guilds']
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      logger.info('Discord OAuth callback received', { userId: profile.id });

      // Extract user data from profile
      const userData = {
        discordId: profile.id,
        username: profile.username,
        discriminator: profile.discriminator,
        avatar: profile.avatar,
        avatarUrl: profile.avatar
          ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
          : `https://cdn.discordapp.com/embed/avatars/${parseInt(profile.discriminator) % 5}.png`,
        email: profile.email,
        accessToken, // Store for guild verification
        refreshToken
      };

      return done(null, userData);
    } catch (error) {
      logger.error('Error in Discord OAuth callback', { error: error.message });
      return done(error, null);
    }
  }
));

// Serialize user for session (we're not using sessions, but required by passport)
passport.serializeUser((user, done) => {
  done(null, user);
});

// Deserialize user from session
passport.deserializeUser((user, done) => {
  done(null, user);
});

module.exports = passport;
