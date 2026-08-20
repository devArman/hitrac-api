-- тарировка ДУТ: соответствие сырых значений датчика литрам (кусочно-линейная интерполяция)
CREATE TABLE "ht_fuel_calibrations" (
    "id" SERIAL NOT NULL,
    "device_id" INTEGER NOT NULL,
    "sensor_key" TEXT NOT NULL DEFAULT 'io270',
    "points" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ht_fuel_calibrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_fuel_calibrations_device_id_key" ON "ht_fuel_calibrations"("device_id");
