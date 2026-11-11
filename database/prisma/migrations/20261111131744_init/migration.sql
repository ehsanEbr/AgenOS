-- CreateEnum
CREATE TYPE "SystemJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "system_jobs" (
    "id" UUID NOT NULL,
    "status" "SystemJobStatus" NOT NULL DEFAULT 'QUEUED',
    "message" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "system_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_jobs_status_created_at_idx" ON "system_jobs"("status", "created_at");
