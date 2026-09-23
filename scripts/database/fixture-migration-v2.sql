ALTER TABLE app.entries ADD COLUMN slug text;
UPDATE app.entries SET slug = 'entry-' || id::text WHERE slug IS NULL;
ALTER TABLE app.entries ALTER COLUMN slug SET NOT NULL;
ALTER TABLE app.entries ADD CONSTRAINT entries_slug_unique UNIQUE (slug);
