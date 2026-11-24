-- QA only (#312): which database this is. The bulk cleanup of old test accounts runs only where
-- this row says al-ummah-now-d1-qa. The migrations/ history (stage, production) never gets the
-- table, so the cleanup cannot run there whatever a worker's vars say.
CREATE TABLE IF NOT EXISTS database_identity (name TEXT PRIMARY KEY);
INSERT OR IGNORE INTO database_identity (name) VALUES ('al-ummah-now-d1-qa');
