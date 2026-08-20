import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { applyFuelCalibration } from './devices.service';

/**
 * Раз в минуту сверяет остаток топлива (по тарировке) с клиентским лимитом.
 * Падение ниже порога — одно уведомление в ht_alerts; флаг сбрасывается,
 * когда уровень снова поднялся выше порога на 5% (заправка).
 */
@Injectable()
export class FuelWatcherService implements OnModuleInit {
  private readonly logger = new Logger(FuelWatcherService.name);

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    setInterval(() => this.check().catch((e) => this.logger.warn(`fuel check: ${e.message}`)), 60000);
  }

  async check() {
    const settings = await this.prisma.htDeviceSetting.findMany({
      where: { minFuelLiters: { not: null } },
    });
    if (!settings.length) return;
    const calibrations = await this.prisma.htFuelCalibration.findMany({
      where: { deviceId: { in: settings.map((s) => s.deviceId) } },
    });
    const calByDevice = new Map(calibrations.map((c) => [c.deviceId, c]));
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT d.id, d.name, p.attributes
      FROM tc_devices d JOIN tc_positions p ON p.id = d.positionid
      WHERE d.id IN (${Prisma.join(settings.map((s) => s.deviceId))})`);
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const setting of settings) {
      const row = byId.get(setting.deviceId);
      const calibration = calByDevice.get(setting.deviceId);
      if (!row || !calibration) continue;
      let attributes: any;
      try { attributes = JSON.parse(row.attributes); } catch { continue; }
      attributes = applyFuelCalibration(attributes, calibration as any);
      const liters = attributes.fuelLiters;
      if (typeof liters !== 'number') continue;

      const min = setting.minFuelLiters!;
      if (liters < min && !setting.fuelAlerted) {
        await this.prisma.$transaction([
          this.prisma.htAlert.create({
            data: {
              deviceId: setting.deviceId,
              type: 'fuelLow',
              message: `остаток топлива ${liters.toFixed(0)} л — ниже лимита ${min.toFixed(0)} л`,
              value: liters,
            },
          }),
          this.prisma.htDeviceSetting.update({
            where: { id: setting.id },
            data: { fuelAlerted: true },
          }),
        ]);
        this.logger.log(`fuelLow: ${row.name} ${liters.toFixed(1)} < ${min}`);
      } else if (setting.fuelAlerted && liters >= min * 1.05) {
        await this.prisma.htDeviceSetting.update({
          where: { id: setting.id },
          data: { fuelAlerted: false },
        });
      }
    }
  }
}
