/*
  Warnings:

  - A unique constraint covering the columns `[branchId,origin,destination]` on the table `Route` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Route" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE UNIQUE INDEX "Route_branchId_origin_destination_key" ON "Route"("branchId", "origin", "destination");
