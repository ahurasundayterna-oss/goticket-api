/*
  Warnings:

  - You are about to drop the column `monnifySubAccountCode` on the `Branch` table. All the data in the column will be lost.
  - You are about to drop the column `bookingRef` on the `WebhookLog` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `WebhookLog` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "WebhookLog_bookingRef_idx";

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "monnifyReference" TEXT;

-- AlterTable
ALTER TABLE "Branch" DROP COLUMN "monnifySubAccountCode";

-- AlterTable
ALTER TABLE "WebhookLog" DROP COLUMN "bookingRef",
DROP COLUMN "status",
ADD COLUMN     "processed" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Booking_monnifyReference_idx" ON "Booking"("monnifyReference");
