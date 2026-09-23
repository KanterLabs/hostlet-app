CREATE TABLE IF NOT EXISTS journal_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS fixture_schema_migrations (
  revision integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fixture_schema_migrations(revision) VALUES (1) ON CONFLICT DO NOTHING;
