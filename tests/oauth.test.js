const { buildDiscordAuthUrl } = require('../src/utils/oauth');

describe('buildDiscordAuthUrl', () => {
  const ORIGINAL_ENV = process.env;
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.DISCORD_CLIENT_ID = 'test-client-id';
    process.env.DISCORD_CALLBACK_URL = 'https://example.test/api/auth/callback';
  });
  afterAll(() => { process.env = ORIGINAL_ENV; });

  test('builds default URL with identify+guilds scope', () => {
    const url = new URL(buildDiscordAuthUrl());
    expect(url.origin + url.pathname).toBe('https://discord.com/api/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/api/auth/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('identify guilds');
    expect(url.searchParams.get('state')).toBeNull();
  });

  test('includes state when provided (CSRF binding)', () => {
    const url = new URL(buildDiscordAuthUrl({ state: 'abc123' }));
    expect(url.searchParams.get('state')).toBe('abc123');
  });

  test('accepts custom scope', () => {
    const url = new URL(buildDiscordAuthUrl({ scope: 'identify' }));
    expect(url.searchParams.get('scope')).toBe('identify');
  });
});
