import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const RATE_LIMIT_MS = 1100; // Nominatim: не чаще одного запроса в секунду
const WARMUP_QUEUE_LIMIT = 500; // предохранитель на размер фоновой очереди

/** Обратный геокодинг с вечным кэшем: координата → адрес. */
@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);
  private lastCall = 0;

  constructor(private readonly prisma: PrismaService) {}

  private static round(value: number) {
    return Math.round(value * 10000) / 10000; // ~11 м
  }

  /** Адреса только из кэша, мгновенно; null — ещё не геокодировано (см. warmup). */
  async lookupCachedMany(points: Array<{ lat: number; lon: number }>) {
    const keys = points.map((p) => ({ lat: GeocodeService.round(p.lat), lon: GeocodeService.round(p.lon) }));
    if (keys.length === 0) return [];
    const cached = await this.prisma.htGeocode.findMany({
      where: { OR: keys.map((k) => ({ lat: k.lat, lon: k.lon })) },
    });
    const byKey = new Map(cached.map((row) => [`${row.lat},${row.lon}`, row.address]));
    return keys.map((k) => byKey.get(`${k.lat},${k.lon}`) ?? null);
  }

  // Фоновый прогрев кэша: промахи геокодятся ПОСЛЕ ответа клиенту.
  // Раньше lookup ждал Nominatim прямо в запросе device-timeline — холодный день
  // открывался ~13 с (12 стоянок × 1.1 с лимита). Теперь лента отвечает сразу,
  // а клиент тихо перезапрашивает её и дополняет адреса из подросшего кэша.
  private readonly queue: Array<{ lat: number; lon: number }> = [];
  private readonly queued = new Set<string>();
  private draining = false;

  /** Поставить точки в фоновую очередь геокодинга (дедупликация, без ожидания). */
  warmup(points: Array<{ lat: number; lon: number }>) {
    for (const p of points) {
      const key = { lat: GeocodeService.round(p.lat), lon: GeocodeService.round(p.lon) };
      const id = `${key.lat},${key.lon}`;
      if (this.queued.has(id) || this.queue.length >= WARMUP_QUEUE_LIMIT) continue;
      this.queued.add(id);
      this.queue.push(key);
    }
    if (!this.draining) void this.drain();
  }

  private async drain() {
    this.draining = true;
    try {
      let next: { lat: number; lon: number } | undefined;
      while ((next = this.queue.shift())) {
        const point = next;
        const id = `${point.lat},${point.lon}`;
        try {
          const hit = await this.prisma.htGeocode.findUnique({
            where: { lat_lon: { lat: point.lat, lon: point.lon } },
          });
          if (hit) continue;
          const address = await this.fetchAddress(point.lat, point.lon); // сам держит паузу 1.1 с
          if (address) {
            await this.prisma.htGeocode.upsert({
              where: { lat_lon: { lat: point.lat, lon: point.lon } },
              update: { address },
              create: { lat: point.lat, lon: point.lon, address },
            }).catch(() => undefined);
          }
        } finally {
          this.queued.delete(id);
        }
      }
    } finally {
      this.draining = false;
    }
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
