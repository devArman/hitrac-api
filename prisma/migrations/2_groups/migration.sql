-- группы: устройства + пользователи; член группы видит все её устройства
CREATE TABLE "ht_groups" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ht_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_groups_name_key" ON "ht_groups"("name");

CREATE TABLE "ht_group_devices" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "device_id" INTEGER NOT NULL,

    CONSTRAINT "ht_group_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_group_devices_group_id_device_id_key" ON "ht_group_devices"("group_id", "device_id");
ALTER TABLE "ht_group_devices" ADD CONSTRAINT "ht_group_devices_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "ht_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ht_group_users" (
    "id" SERIAL NOT NULL,
    "group_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "ht_group_users_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_group_users_group_id_user_id_key" ON "ht_group_users"("group_id", "user_id");
ALTER TABLE "ht_group_users" ADD CONSTRAINT "ht_group_users_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "ht_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ht_group_users" ADD CONSTRAINT "ht_group_users_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "ht_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
