import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedUser } from '../auth/decorators';

/**
 * Чтение устройств и позиций напрямую из таблиц Traccar (tc_*),
 * с фильтрацией по нашей карте прав ht_user_devices.
 */
@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /** null — пользователь видит все устройства (право "*") */
  async allowedIds(user: AuthedUser): Promise<number[] | null> {
    if (user.role?.permissions.includes('*')) return null;
    // прямые привязки + устройства групп, где пользователь состоит
    const [direct, viaGroups] = await Promise.all([
      this.prisma.htUserDevice.findMany({ where: { userId: user.id } }),
      this.prisma.htGroupDevice.findMany({
        where: { group: { users: { some: { userId: user.id } } } },
      }),
    ]);
    return [...new Set([...direct.map((r) => r.deviceId), ...viaGroups.map((r) => r.deviceId)])];
  }

  async assertAllowed(user: AuthedUser, deviceIds: number[]) {
    const allowed = await this.allowedIds(user);
    if (allowed === null) return;
    const set = new Set(allowed);
    if (deviceIds.some((id) => !set.has(id))) {
      throw new ForbiddenException('Нет доступа к устройству');
    }
  }

  async devices(user: AuthedUser) {
    const allowed = await this.allowedIds(user);
    if (allowed !== null && allowed.length === 0) return [];
    const where = allowed === null ? Prisma.empty : Prisma.sql`WHERE d.id IN (${Prisma.join(allowed)})`;
    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT d.id, d.name, d.uniqueid, d.status, d.lastupdate, d.model, d.contact, d.phone, d.attributes
      FROM tc_devices d ${where} ORDER BY d.name`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      uniqueId: r.uniqueid,
      // в tc_devices это CHAR(8) — Postgres добивает значение пробелами
      status: (r.status ?? 'offline').trim(),
      lastUpdate: r.lastupdate,
      model: r.model,
      contact: r.contact,
      phone: r.phone,
      attributes: parseJson(r.attributes),
    }));
  }

  async positions(user: AuthedUser) {
    const allowed = await this.allowedIds(user);
    if (allowed !== null && allowed.length === 0) return [];
    const where = allowed === null ? Prisma.empty : Prisma.sql`AND d.id IN (${Prisma.join(allowed)})`;
    const [rows, calibrations] = await Promise.all([
      this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT p.id, p.deviceid, p.protocol, p.latitude, p.longitude, p.speed, p.course, p.altitude,
             p.fixtime, p.devicetime, p.servertime, p.address, p.attributes
      FROM tc_devices d JOIN tc_positions p ON p.id = d.positionid
      WHERE d.positionid IS NOT NULL ${where}`),
      this.prisma.htFuelCalibration.findMany(),
    ]);
    const calByDevice = new Map(calibrations.map((c) => [c.deviceId, c]));
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.deviceid,
      protocol: r.protocol,
      latitude: r.latitude,
      longitude: r.longitude,
      speed: r.speed,
      course: r.course,
      altitude: r.altitude,
      fixTime: r.fixtime,
      deviceTime: r.devicetime,
      serverTime: r.servertime,
      address: r.address,
      attributes: applyFuelCalibration(parseJson(r.attributes), calByDevice.get(r.deviceid)),
    }));
  }
}

/** points: [{raw, liters}] по возрастанию raw; кусочно-линейная интерполяция с ограничением по краям */
export function applyFuelCalibration(attributes: any, calibration?: { sensorKey: string; points: any }) {
  const points = calibration?.points as Array<{ raw: number; liters: number }> | undefined;
  if (!points || points.length < 2) return attributes;
  const raw = attributes?.[calibration!.sensorKey];
  if (typeof raw !== 'number') return attributes;

  let liters: number;
  if (raw <= points[0].raw) {
    liters = points[0].liters;
  } else if (raw >= points[points.length - 1].raw) {
    liters = points[points.length - 1].liters;
  } else {
    liters = points[0].liters;
    for (let i = 1; i < points.length; i++) {
      if (raw <= points[i].raw) {
        const a = points[i - 1];
        const b = points[i];
        const t = b.raw === a.raw ? 0 : (raw - a.raw) / (b.raw - a.raw);
        liters = a.liters + t * (b.liters - a.liters);
        break;
      }
    }
  }
  const maxLiters = Math.max(...points.map((p) => p.liters));
  return {
    ...attributes,
    fuelLiters: Math.round(liters * 10) / 10,
    ...(maxLiters > 0 ? { fuel: Math.round((liters / maxLiters) * 100) } : {}),
  };
}

function parseJson(value: unknown) {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return {}; }
}
