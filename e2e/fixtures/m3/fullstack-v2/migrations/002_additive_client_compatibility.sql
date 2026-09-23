ALTER TABLE journal_items ADD COLUMN IF NOT EXISTS detail text NOT NULL DEFAULT '';
ALTER TABLE journal_items ADD COLUMN IF NOT EXISTS client_release text;
INSERT INTO fixture_schema_migrations(revision) VALUES (2) ON CONFLICT DO NOTHING;
