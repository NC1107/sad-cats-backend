-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create update_updated_at_column function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create notify_score_change function for real-time updates
CREATE OR REPLACE FUNCTION notify_score_change()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('score_updated', row_to_json(NEW)::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Scores table (maintains Supabase compatibility)
CREATE TABLE IF NOT EXISTS scores (
    user_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    discord_id VARCHAR(255) NOT NULL UNIQUE,
    username VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    score BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Constraints
    CONSTRAINT score_non_negative CHECK (score >= 0)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_scores_discord_id ON scores(discord_id);
CREATE INDEX IF NOT EXISTS idx_scores_score_desc ON scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_updated_at ON scores(updated_at);

-- Trigger to auto-update updated_at
CREATE TRIGGER update_scores_updated_at
    BEFORE UPDATE ON scores
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger for real-time notifications
CREATE TRIGGER score_change_trigger
    AFTER INSERT OR UPDATE ON scores
    FOR EACH ROW
    EXECUTE FUNCTION notify_score_change();

-- Blacklisted tokens table for JWT revocation
CREATE TABLE IF NOT EXISTS blacklisted_tokens (
    id SERIAL PRIMARY KEY,
    token_jti VARCHAR(255) NOT NULL UNIQUE,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for blacklist
CREATE INDEX IF NOT EXISTS idx_blacklist_jti ON blacklisted_tokens(token_jti);
CREATE INDEX IF NOT EXISTS idx_blacklist_expires ON blacklisted_tokens(expires_at);

-- Log successful migration
DO $$
BEGIN
    RAISE NOTICE 'Initial schema migration completed successfully';
END
$$;
