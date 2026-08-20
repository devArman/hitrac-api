import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const KNOTS_TO_KMH = 1.852;
const SPEED_MIN_KMH = 10; // ниже — дрожание GPS на стоянке
const CONFIRM_CHECKS = 2; // подряд, прежде чем алертить
const COOLDOWN_MS = 30 * 60000; // не чаще раза в полчаса на устройство
const FRESH_MS = 5 * 60000; // позиция не старше 5 минут

/**
 * Раз в 30 секунд ищет устройства, которые движутся с выключенным зажиганием —
 * признак перевозки на эвакуаторе (или буксировки/угона). Два подтверждения
 * подряд — одно уведомление в ht_alerts с получасовым кулдауном.
 */
@Injectable()
export class TowWatcherService implements OnModuleInit {
  private readonly logger = new Logger(TowWatcherService.name);
  private readonly streak = new Map<number, number>();
  private readonly lastAlert = new Map<number, number>();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    setInterval(() => this.check().catch((e) => this.logger.warn(`tow check: ${e.message}`)), 30000);
  }

  async check() {
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT d.id, d.name, p.speed, p.fixtime, p.attributes
      FROM tc_devices d JOIN tc_positions p ON p.id = d.positionid
      WHERE d.positionid IS NOT NULL`);
    const now = Date.now();
    for (const row of rows) {
      let attributes: any;
      try { attributes = JSON.parse(row.attributes); } catch { continue; }
      const speedKmh = (Number(row.speed) || 0) * KNOTS_TO_KMH;
      const fresh = row.fixtime && now - new Date(row.fixtime).getTime() < FRESH_MS;
      const towing = fresh && attributes?.ignition === false && speedKmh >= SPEED_MIN_KMH;
      if (!towing) {
        this.streak.delete(row.id);
        continue;
      }
      const streak = (this.streak.get(row.id) ?? 0) + 1;
      this.streak.set(row.id, streak);
      if (streak < CONFIRM_CHECKS) continue;
      if (now - (this.lastAlert.get(row.id) ?? 0) < COOLDOWN_MS) continue;
      this.lastAlert.set(row.id, now);
      await this.prisma.htAlert.create({
        data: {
          deviceId: row.id,
          type: 'towing',
          message: `движение с выключенным зажиганием (${Math.round(speedKmh)} км/ч) — возможно, машину перевозят на эвакуаторе`,
          value: Math.round(speedKmh),
        },
      });
      this.logger.log(`towing: ${row.name} ${Math.round(speedKmh)} km/h, ignition off`);
    }
  }
}
