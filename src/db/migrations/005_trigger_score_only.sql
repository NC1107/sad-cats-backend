-- Fix: Only fire pg_notify when the score column actually changes.
-- Previously, saveGameState (which only updates game_state column) also
-- triggered the notification, broadcasting stale scores and causing the
-- frontend socket handler to revert purchase deductions.

CREATE OR REPLACE FUNCTION notify_score_change()
RETURNS TRIGGER AS $$
BEGIN
    -- On INSERT always notify; on UPDATE only when score changed
    IF TG_OP = 'INSERT' OR OLD.score IS DISTINCT FROM NEW.score THEN
        PERFORM pg_notify('score_updated', row_to_json(NEW)::text);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
