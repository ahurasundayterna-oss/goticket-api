/*
  Warnings:

  - A unique constraint covering the columns `[reference]` on the table `WalletTransaction` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "WalletTransaction" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'SUCCESS';

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_reference_key" ON "WalletTransaction"("reference");

-- CreateIndex
CREATE INDEX "WalletTransaction_reference_idx" ON "WalletTransaction"("reference");
