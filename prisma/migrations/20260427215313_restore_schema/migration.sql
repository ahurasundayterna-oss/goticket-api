/*
  Warnings:

  - You are about to drop the column `paymentMethod` on the `Booking` table. All the data in the column will be lost.
  - The `paymentStatus` column on the `Booking` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `Booking` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `Park` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `Trip` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `tripType` column on the `Trip` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `role` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- DropIndex
DROP INDEX "Booking_createdAt_idx";

-- DropIndex
DROP INDEX "Booking_paymentStatus_idx";

-- DropIndex
DROP INDEX "Booking_tripId_seatNumber_key";

-- DropIndex
DROP INDEX "Trip_createdAt_idx";

-- DropIndex
DROP INDEX "Trip_status_idx";

-- AlterTable
ALTER TABLE "Booking" DROP COLUMN "paymentMethod",
DROP COLUMN "paymentStatus",
ADD COLUMN     "paymentStatus" TEXT,
DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE "Park" DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Trip" DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OPEN',
DROP COLUMN "tripType",
ADD COLUMN     "tripType" TEXT NOT NULL DEFAULT 'SCHEDULED';

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'BRANCH_ADMIN';

-- DropEnum
DROP TYPE "BookingStatus";

-- DropEnum
DROP TYPE "ParkStatus";

-- DropEnum
DROP TYPE "PaymentMethod";

-- DropEnum
DROP TYPE "PaymentStatus";

-- DropEnum
DROP TYPE "TripStatus";

-- DropEnum
DROP TYPE "TripType";

-- DropEnum
DROP TYPE "UserRole";
