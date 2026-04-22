/*
  Warnings:

  - You are about to drop the column `createdAt` on the `Branch` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[reference]` on the table `Booking` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `createdById` to the `Trip` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "accountNumber" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "paymentStatus" TEXT,
ADD COLUMN     "totalAmount" DOUBLE PRECISION,
ALTER COLUMN "bookingSource" SET DEFAULT 'MANUAL';

-- AlterTable
ALTER TABLE "Branch" DROP COLUMN "createdAt",
ADD COLUMN     "monnifySubAccountCode" TEXT;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "createdById" TEXT NOT NULL,
ADD COLUMN     "fillThreshold" INTEGER,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OPEN',
ADD COLUMN     "tripType" TEXT NOT NULL DEFAULT 'SCHEDULED',
ALTER COLUMN "departureTime" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
