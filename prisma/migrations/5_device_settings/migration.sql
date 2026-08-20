-- клиентские лимиты на устройство + наши автоматические уведомления
CREATE TABLE "ht_device_settings" (
    "id" SERIAL NOT NULL,
    "device_id" INTEGER NOT NULL,
    "speed_limit_kmh" DOUBLE PRECISION,
    "min_fuel_liters" DOUBLE PRECISION,
    "fuel_alerted" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ht_device_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_device_settings_device_id_key" ON "ht_device_settings"("device_id");

CREATE TABLE "ht_alerts" (
    "id" SERIAL NOT NULL,
    "device_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ht_alerts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ht_alerts_device_id_created_at_idx" ON "ht_alerts"("device_id", "created_at");
