DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "WalletLedger" WHERE "entryType" = 'RESERVATION_RELEASE'
  ) THEN
    RAISE EXCEPTION 'Cannot add reservation source binding: existing RESERVATION_RELEASE rows need an audited backfill first';
  END IF;
END $$;

ALTER TABLE "WalletLedger" ADD COLUMN "reservationReferenceId" TEXT;
CREATE INDEX "WalletLedger_reservationReferenceId_idx" ON "WalletLedger"("reservationReferenceId");
ALTER TABLE "WalletLedger"
  ADD CONSTRAINT "WalletLedger_reservationReferenceId_fkey"
  FOREIGN KEY ("reservationReferenceId")
  REFERENCES "WalletLedger"("referenceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
