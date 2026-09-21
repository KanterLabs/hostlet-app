-- Additive recovery metadata. Schema-3 readers remain supported.
CREATE TABLE platform_backup_receipts (
    backup_id uuid PRIMARY KEY,
    database_identity_id uuid NOT NULL REFERENCES database_identity(id),
    schema_version bigint NOT NULL CHECK (schema_version > 0),
    intended_migration bigint NOT NULL CHECK (intended_migration > schema_version),
    receipt jsonb NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
    verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $$
BEGIN
    UPDATE platform_schema_compatibility
    SET current_version = 4,
        min_reader_version = 3,
        updated_at = transaction_timestamp()
    WHERE singleton = true AND current_version = 3 AND min_reader_version = 1;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'unexpected schema compatibility state before migration 0004';
    END IF;
END
$$;
