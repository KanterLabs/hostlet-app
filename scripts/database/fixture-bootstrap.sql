CREATE TABLE app.authors (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    display_name text NOT NULL
);

CREATE TABLE app.entries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    author_id bigint NOT NULL REFERENCES app.authors(id),
    title text NOT NULL,
    body text NOT NULL
);

INSERT INTO app.authors(display_name) VALUES ('Owned Fixture Author');
INSERT INTO app.entries(author_id, title, body)
SELECT id, 'First owned entry', 'Populated relationship used by restore validation'
FROM app.authors
WHERE display_name = 'Owned Fixture Author';

CREATE TABLE app.journal_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.fixture_schema_migrations (
    revision integer PRIMARY KEY
);

INSERT INTO app.fixture_schema_migrations(revision) VALUES (1);
INSERT INTO app.journal_items(name) VALUES ('Owned populated journal item');
