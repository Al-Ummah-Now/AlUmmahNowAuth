-- The D1 `logs` table: dead since 2026-11-09 (b10f3d9, #255: log lines go to Workers Logs, nothing
-- reads the table). It kept every old line: about 14M rows and most of QA's 3.66 GB, so any full scan
-- of it took D1 over a minute and Auth's own queries failed meanwhile (2026-11-13 11:09-11:11 UTC QA
-- /authorize 500s, #341: a hand audit sweep LIKE-scanned every column of every table). Unexpected
-- errors now go to the videos admin Errors page (src/errors/report.ts); nothing else is kept here.
DROP INDEX IF EXISTS idx_logs_level;
DROP INDEX IF EXISTS idx_logs_timestamp;
DROP TABLE IF EXISTS logs;
