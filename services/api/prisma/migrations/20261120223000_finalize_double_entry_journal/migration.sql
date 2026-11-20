-- Complete the journal's one-way posting lifecycle and align the database with Prisma.
ALTER TABLE "JournalTransaction"
  ADD COLUMN "postedAt" TIMESTAMP(3);

-- Permit only the one-way NULL -> timestamp finalization transition on a header.
-- Every other header update/delete remains forbidden.
CREATE OR REPLACE FUNCTION "reject_journal_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'JournalTransaction'
     AND TG_OP = 'UPDATE'
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
END;
$$ LANGUAGE plpgsql;

-- Entries may be inserted only while their parent transaction is being assembled.
CREATE FUNCTION "guard_journal_entry_insert"() RETURNS trigger AS $$
DECLARE
  parent_posted_at TIMESTAMP(3);
BEGIN
  SELECT "postedAt" INTO parent_posted_at
    FROM "JournalTransaction"
    WHERE "id" = NEW."transactionId"
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journal transaction does not exist' USING ERRCODE = '23503';
  END IF;
  IF parent_posted_at IS NOT NULL THEN
    RAISE EXCEPTION 'cannot append entries to a posted journal transaction'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalEntry_insert_only_before_posting"
  BEFORE INSERT ON "JournalEntry"
  FOR EACH ROW EXECUTE FUNCTION "guard_journal_entry_insert"();

-- At commit, every journal header touched in the transaction must be finalized
-- and contain at least two entries whose debit and credit totals are equal > 0.
CREATE FUNCTION "assert_journal_transaction_balanced"() RETURNS trigger AS $$
DECLARE
  current_posted_at TIMESTAMP(3);
  entry_count BIGINT;
  debit_total BIGINT;
  credit_total BIGINT;
BEGIN
  SELECT "postedAt" INTO current_posted_at
    FROM "JournalTransaction" WHERE "id" = NEW."id";
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF current_posted_at IS NULL THEN
    RAISE EXCEPTION 'journal transaction must be finalized before commit'
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*), COALESCE(SUM("debitCents"), 0), COALESCE(SUM("creditCents"), 0)
    INTO entry_count, debit_total, credit_total
    FROM "JournalEntry" WHERE "transactionId" = NEW."id";
  IF entry_count < 2 OR debit_total <= 0 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'journal transaction must contain at least two balanced entries'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "JournalTransaction_must_finalize_balanced"
  AFTER INSERT OR UPDATE ON "JournalTransaction"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "assert_journal_transaction_balanced"();

-- Row triggers do not fire for TRUNCATE; reject it explicitly.
CREATE FUNCTION "reject_journal_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal history cannot be truncated'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "JournalTransaction_no_truncate"
  BEFORE TRUNCATE ON "JournalTransaction"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_journal_truncate"();

CREATE TRIGGER "JournalEntry_no_truncate"
  BEFORE TRUNCATE ON "JournalEntry"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_journal_truncate"();
