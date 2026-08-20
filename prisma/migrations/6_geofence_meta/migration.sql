-- владелец геозоны: NULL — общая (создана админом, видна всем), иначе личная зона клиента
CREATE TABLE "ht_geofence_meta" (
    "id" SERIAL NOT NULL,
    "geofence_id" INTEGER NOT NULL,
    "owner_user_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ht_geofence_meta_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ht_geofence_meta_geofence_id_key" ON "ht_geofence_meta"("geofence_id");
