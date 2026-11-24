-- Migration: 0050_account_event_client_index
-- Admin > Account events (AlUmmahNowAuth#507 C1c): a client's last delivery, its pending and its
-- failed deliveries, newest first, without reading its other rows.
CREATE INDEX IF NOT EXISTS idx_account_event_deliveries_client ON account_event_deliveries(client_id, status, settled_at);
