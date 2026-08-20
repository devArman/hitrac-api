-- телефон клиента + карта прав пользователь→устройство
ALTER TABLE "ht_users" ADD COLUMN "phone" TEXT;

CREATE TABLE "ht_user_devices" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "device_id" INTEGER NOT NULL,

    CONSTRAINT "ht_user_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ht_user_devices_user_id_device_id_key" ON "ht_user_devices"("user_id", "device_id");

ALTER TABLE "ht_user_devices" ADD CONSTRAINT "ht_user_devices_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "ht_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
