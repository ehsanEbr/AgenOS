-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "identity";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "security";

-- CreateEnum
CREATE TYPE "security"."AuditResult" AS ENUM ('success', 'failure');

-- CreateEnum
CREATE TYPE "identity"."UserStatus" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "security"."audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" UUID,
    "organization_id" UUID,
    "project_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "result" "security"."AuditResult" NOT NULL,
    "correlation_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "status" "identity"."UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."credential" (
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "identity"."session" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "user_agent" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_organization_id_occurred_at_id_idx" ON "security"."audit_log"("organization_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "security"."audit_log"("action");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "identity"."user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_hash_key" ON "identity"."session"("token_hash");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "identity"."session"("user_id");

-- AddForeignKey
ALTER TABLE "identity"."credential" ADD CONSTRAINT "credential_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity"."session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "identity"."user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
