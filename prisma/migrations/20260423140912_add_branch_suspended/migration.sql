-- AlterTable
ALTER TABLE "Branch" ADD COLUMN     "suspended" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Trip" ADD COLUMN     "seatsBooked" INTEGER NOT NULL DEFAULT 0;
