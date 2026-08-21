import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const RATE_LIMIT_MS = 1100; // Nominatim: не чаще одного запроса в секунду
const MAX_LOOKUPS_PER_REQUEST = 12; // остальное подтянется при следующем открытии

/** Обратный геокодинг с вечным кэшем: координата → адрес. */
@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);
  private lastCall = 0;

  constructor(private readonly prisma: PrismaService) {}

  private static round(value: number) {
    return Math.round(value * 10000) / 10000; // ~11 м
  }

  /** Адреса для набора точек: из кэша мгновенно, промахи — по одному в секунду. */
  async lookupMany(points: Array<{ lat: number; lon: number }>) {
    const keys = points.map((p) => ({ lat: GeocodeService.round(p.lat), lon: GeocodeService.round(p.lon) }));
    const cached = await this.prisma.htGeocode.findMany({
      where: { OR: keys.map((k) => ({ lat: k.lat, lon: k.lon })) },
    });
    const byKey = new Map(cached.map((row) => [`${row.lat},${row.lon}`, row.address]));

    let budget = MAX_LOOKUPS_PER_REQUEST;
    for (const key of keys) {
      const id = `${key.lat},${key.lon}`;
      if (byKey.has(id) || budget <= 0) continue;
      budget -= 1;
      // eslint-disable-next-line no-await-in-loop
      const address = await this.fetchAddress(key.lat, key.lon);
      if (address) {
        byKey.set(id, address);
        // eslint-disable-next-line no-await-in-loop
        await this.prisma.htGeocode.upsert({
          where: { lat_lon: { lat: key.lat, lon: key.lon } },
          update: { address },
          create: { lat: key.lat, lon: key.lon, address },
        }).catch(() => undefined);
      }
    }

    return keys.map((k) => byKey.get(`${k.lat},${k.lon}`) ?? null);
  }

  private async fetchAddress(lat: number, lon: number): Promise<string | null> {
    const wait = RATE_LIMIT_MS - (Date.now() - this.lastCall);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastCall = Date.now();

    const url = `${NOMINATIM}?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=hy&zoom=17`;
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'HiTrack/1.0 (https://hitrack.am)', Accept: 'application/json' },
        signal: AbortSignal.timeout(6000),
      });
      if (!response.ok) {
        this.logger.warn(`Nominatim ${response.status} для ${lat},${lon}`);
        return null;
      }
      const body: any = await response.json();
      return body?.display_name ?? null;
    } catch (error) {
      this.logger.warn(`Nominatim недоступен: ${(error as Error).message}`);
      return null;
    }
  }
}
