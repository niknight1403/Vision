-- Finalize journal headers only after their complete balanced entry set is present.
ALTER TABLE "JournalTransaction" ADD COLUMN "postedAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION "reject_journal_mutation"() RETURNS trigger AS $$
DECLARE
  parent_posted_at TIMESTAMP(3);
BEGIN
  IF TG_TABLE_NAME = 'JournalTransaction' THEN
    IF TG_OP = 'UPDATE'
      AND OLD."postedAt" IS NULL
      AND NEW."postedAt" IS NOT NULL
      AND NEW."id" = OLD."id"
      AND NEW."tenantId" = OLD."tenantId"
      AND NEW."referenceId" = OLD."referenceId"
      AND NEW."currency" = OLD."currency"
      AND NEW."description" = OLD."description"
      AND NEW."payloadHash" = OLD."payloadHash"
      AND NEW."createdAt" = OLD."createdAt" THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'journal records are immutable; post a compensating transaction'
      USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'JournalEntry' AND TG_OP = 'INSERT' THEN
    SELECT "postedAt" INTO parent_posted_at
      FROM "JournalTransaction" WHERE "id" = NEW."transactionId";
    IF NOT FOUND OR parent_posted_at IS NOT NULL THEN
      RAISE EXCEPTION 'cannot append entries to a finalized journal transaction'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'journal records are immutable; post a compensating transaction'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "JournalEntry_immutable" ON "JournalEntry";
CREATE TRIGGER "JournalEntry_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION "reject_journal_mutation"();

CREATE FUNCTION "reject_journal_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal tables cannot be truncated'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalTransaction_no_truncate"
  BEFORE TRUNCATE ON "JournalTransaction"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_journal_truncate"();
CREATE TRIGGER "JournalEntry_no_truncate"
  BEFORE TRUNCATE ON "JournalEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_journal_truncate"();

CREATE FUNCTION "validate_journal_transaction_posted"() RETURNS trigger AS $$
DECLARE
  current_posted_at TIMESTAMP(3);
  entry_count BIGINT;
  debit_total BIGINT;
  credit_total BIGINT;
BEGIN
  SELECT "postedAt" INTO current_posted_at
    FROM "JournalTransaction" WHERE "id" = NEW."id";
  SELECT COUNT(*), COALESCE(SUM("debitCents"), 0), COALESCE(SUM("creditCents"), 0)
    INTO entry_count, debit_total, credit_total
    FROM "JournalEntry" WHERE "transactionId" = NEW."id";

  IF current_posted_at IS NULL OR entry_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'journal transaction must be finalized with at least two balanced entries'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "JournalTransaction_finalize_check"
  AFTER INSERT OR UPDATE ON "JournalTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "validate_journal_transaction_posted"();
