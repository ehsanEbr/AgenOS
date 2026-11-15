-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "projects";

-- CreateEnum
CREATE TYPE "projects"."project_status" AS ENUM ('active', 'archived');

-- CreateEnum
CREATE TYPE "projects"."project_role" AS ENUM ('project_admin', 'project_member', 'project_viewer');

-- CreateTable
CREATE TABLE "projects"."project" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "projects"."project_status" NOT NULL DEFAULT 'active',
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects"."project_member" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "projects"."project_role" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_member_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_organization_id_status_created_at_id_idx" ON "projects"."project"("organization_id", "status", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "project_organization_id_slug_key" ON "projects"."project"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "project_id_organization_id_key" ON "projects"."project"("id", "organization_id");

-- CreateIndex
CREATE INDEX "project_member_organization_id_user_id_idx" ON "projects"."project_member"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "project_member_user_id_idx" ON "projects"."project_member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_member_project_id_user_id_key" ON "projects"."project_member"("project_id", "user_id");

-- AddForeignKey
ALTER TABLE "projects"."project" ADD CONSTRAINT "project_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity"."organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."project_member" ADD CONSTRAINT "project_member_project_id_organization_id_fkey" FOREIGN KEY ("project_id", "organization_id") REFERENCES "projects"."project"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects"."project_member" ADD CONSTRAINT "project_member_organization_id_user_id_fkey" FOREIGN KEY ("organization_id", "user_id") REFERENCES "identity"."membership"("organization_id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

