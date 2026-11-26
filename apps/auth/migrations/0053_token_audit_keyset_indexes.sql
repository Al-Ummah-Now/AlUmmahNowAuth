-- Keep the original indexes for existing queries and rollback compatibility.
CREATE INDEX idx_token_usage_created_at_id ON token_usage(created_at, id);
CREATE INDEX idx_token_usage_user_created_at ON token_usage(user_id, created_at, id);
CREATE INDEX idx_token_usage_client_created_at ON token_usage(client_id, created_at, id);
CREATE INDEX idx_token_usage_action_created_at ON token_usage(token_type, created_at, id);
