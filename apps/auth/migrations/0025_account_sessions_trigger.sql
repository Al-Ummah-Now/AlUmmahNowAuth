-- Migration: 0024_account_sessions_trigger
-- Description: Trigger to ensure only one active account per browser session
-- This automatically deactivates other accounts when a new account is activated

-- Trigger to ensure only one active account per browser session
DROP TRIGGER IF EXISTS ensure_single_active_account;

CREATE TRIGGER ensure_single_active_account
BEFORE UPDATE ON account_sessions
WHEN NEW.is_active = 1
BEGIN
    UPDATE account_sessions
    SET is_active = 0
    WHERE browser_session_id = NEW.browser_session_id
    AND id != NEW.id;
END;
