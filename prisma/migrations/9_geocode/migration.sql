-- кэш обратного геокодинга (Nominatim ограничивает 1 запрос/с)
CREATE TABLE ht_geocode (
    id          SERIAL PRIMARY KEY,
    lat         DOUBLE PRECISION NOT NULL,
    lon         DOUBLE PRECISION NOT NULL,
    address     TEXT NOT NULL,
    created_at  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "ht_geocode_lat_lon_key" ON ht_geocode(lat, lon);
