-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ht_roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "ht_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ht_users" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "role_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ht_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ht_roles_name_key" ON "ht_roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ht_users_email_key" ON "ht_users"("email");

-- AddForeignKey
ALTER TABLE "ht_users" ADD CONSTRAINT "ht_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "ht_roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

