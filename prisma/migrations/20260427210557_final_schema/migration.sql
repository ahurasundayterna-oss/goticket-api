/*
  Warnings:

  - The values [CLOSED] on the enum `TripStatus` will be removed. If these variants are still used in the database, this will fail.
  - The `status` column on the `Park` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `tripType` column on the `Trip` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - A unique constraint covering the columns `[tripId,seatNumber]` on the table `Booking` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'PARK_ADMIN', 'BRANCH_ADMIN', 'STAFF');

-- CreateEnum
CREATE TYPE "TripType" AS ENUM ('SCHEDULED', 'INSTANT');

-- CreateEnum
CREATE TYPE "ParkStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterEnum
BEGIN;
CREATE TYPE "TripStatus_new" AS ENUM ('OPEN', 'CANCELLED', 'DEPARTED');
ALTER TABLE "Trip" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Trip" ALTER COLUMN "status" TYPE "TripStatus_new" USING ("status"::text::"TripStatus_new");
ALTER TYPE "TripStatus" RENAME TO "TripStatus_old";
ALTER TYPE "TripStatus_new" RENAME TO "TripStatus";
DROP TYPE "TripStatus_old";
ALTER TABLE "Trip" ALTER COLUMN "status" SET DEFAULT 'OPEN';
COMMIT;

-- AlterTable
ALTER TABLE "Park" DROP COLUMN "status",
ADD COLUMN     "status" "ParkStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Trip" DROP COLUMN "tripType",
ADD COLUMN     "tripType" "TripType" NOT NULL DEFAULT 'SCHEDULED';

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'BRANCH_ADMIN';

-- CreateIndex
CREATE INDEX "Booking_createdAt_idx" ON "Booking"("createdAt");

-- CreateIndex
CREATE INDEX "Booking_paymentStatus_idx" ON "Booking"("paymentStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_tripId_seatNumber_key" ON "Booking"("tripId", "seatNumber");

-- CreateIndex
CREATE INDEX "Trip_createdAt_idx" ON "Trip"("createdAt");

-- CreateIndex
CREATE INDEX "Trip_status_idx" ON "Trip"("status");
