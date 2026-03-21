-- Initial D1 schema for pastes, comments, and the indexes used by cleanup queries.
CREATE TABLE IF NOT EXISTS pastes (
	id TEXT PRIMARY KEY,
	schema_version INTEGER NOT NULL DEFAULT 2,
	blob_key TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	expire_at INTEGER,
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'claimed', 'burned', 'expired', 'deleted')),
	burn_after_reading INTEGER NOT NULL DEFAULT 0,
	discussion_open INTEGER NOT NULL DEFAULT 0,
	formatter TEXT NOT NULL DEFAULT 'plaintext',
	has_attachment INTEGER NOT NULL DEFAULT 0,
	delete_token_hash TEXT NOT NULL,
	claim_token_hash TEXT,
	claim_expires_at INTEGER,
	comment_count INTEGER NOT NULL DEFAULT 0,
	size_bytes INTEGER NOT NULL DEFAULT 0,
	import_source TEXT,
	metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_pastes_status_expire ON pastes(status, expire_at);
CREATE INDEX IF NOT EXISTS idx_pastes_claim_expires ON pastes(status, claim_expires_at);

CREATE TABLE IF NOT EXISTS comments (
	id TEXT PRIMARY KEY,
	paste_id TEXT NOT NULL,
	parent_id TEXT NOT NULL,
	blob_key TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	size_bytes INTEGER NOT NULL DEFAULT 0,
	FOREIGN KEY (paste_id) REFERENCES pastes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_comments_paste_created ON comments(paste_id, created_at);
