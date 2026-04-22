-- CreateTable
CREATE TABLE "RouteStaffAssignment" (
    "id" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RouteStaffAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RouteStaffAssignment_routeId_staffId_key" ON "RouteStaffAssignment"("routeId", "staffId");

-- AddForeignKey
ALTER TABLE "RouteStaffAssignment" ADD CONSTRAINT "RouteStaffAssignment_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RouteStaffAssignment" ADD CONSTRAINT "RouteStaffAssignment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
