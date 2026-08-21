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
      SELECT d.id, d.name, d.uniqueid, d.status, d.lastupdate, d.model, d.category, d.contact, d.phone, d.attributes
      FROM tc_devices d ${where} ORDER BY d.name`);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      uniqueId: r.uniqueid,
      // в tc_devices это CHAR(8) — Postgres добивает значение пробелами
      status: (r.status ?? 'offline').trim(),
      lastUpdate: r.lastupdate,
      model: r.model,
      category: r.category,
      contact: r.contact,
      phone: r.phone,
      attributes: parseJson(r.attributes),
    }));
  }

  /**
   * Суточная статистика для списков устройств: пробег и макс. скорость из
   * tc_positions (пробег — по totalDistance, fallback — сумма distance),
   * число превышений скорости из tc_events. from — начало дня клиента.
   */
  async dayStats(user: AuthedUser, from: Date, to: Date = new Date(), only: number[] | null = null) {
    // only — конкретные устройства; доступ к ним проверяет контроллер
    const allowed = only ?? await this.allowedIds(user);
    if (allowed !== null && allowed.length === 0) return [];
    const wherePos = allowed === null ? Prisma.empty : Prisma.sql`AND p.deviceid IN (${Prisma.join(allowed)})`;
    const whereEv = allowed === null ? Prisma.empty : Prisma.sql`AND e.deviceid IN (${Prisma.join(allowed)})`;
    const [pos, events] = await Promise.all([
      // пробег считаем сами хаверсином по fixtime: attributes.distance у Traccar
      // идёт по порядку ПРИХОДА пакетов и рвётся, когда трекер заливает бэклог
      // вперемешку с live. Отсечки: <15 м — GPS-дрейф стоянки, >70 м/с (~250 км/ч)
      // между фиксами — нефизичный скачок
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        WITH pts AS (
          SELECT p.deviceid, p.fixtime, p.speed,
                 radians(p.latitude) AS lat, radians(p.longitude) AS lon,
                 LAG(radians(p.latitude)) OVER w AS plat,
                 LAG(radians(p.longitude)) OVER w AS plon,
                 LAG(p.fixtime) OVER w AS ptime
          FROM tc_positions p
          WHERE p.fixtime >= ${from} AND p.fixtime <= ${to} AND p.valid ${wherePos}
          WINDOW w AS (PARTITION BY p.deviceid ORDER BY p.fixtime)
        ), hops AS (
          SELECT deviceid, speed,
                 2 * 6371000 * asin(LEAST(1, sqrt(
                   sin((lat - plat) / 2) ^ 2 +
                   cos(plat) * cos(lat) * sin((lon - plon) / 2) ^ 2
                 ))) AS dist,
                 GREATEST(EXTRACT(EPOCH FROM (fixtime - ptime)), 1) AS dt
          FROM pts
        )
        SELECT deviceid, MAX(speed) AS maxspeed,
               SUM(dist) FILTER (WHERE dist >= 15 AND dist / dt <= 70) AS dist
        FROM hops GROUP BY deviceid`),
      this.prisma.$queryRaw<any[]>(Prisma.sql`
        SELECT e.deviceid, COUNT(*)::int AS overspeed
        FROM tc_events e
        WHERE e.type = 'deviceOverspeed' AND e.eventtime >= ${from} AND e.eventtime <= ${to} ${whereEv}
        GROUP BY e.deviceid`),
    ]);
    const overspeedBy = new Map(events.map((r) => [r.deviceid, r.overspeed]));
    return pos.map((r) => ({
      deviceId: r.deviceid,
      distanceMeters: Math.round(r.dist ?? 0),
      maxSpeedKnots: r.maxspeed ?? 0,
      overspeedCount: overspeedBy.get(r.deviceid) ?? 0,
    }));
  }

  /**
   * Свой детектор поездок по tc_positions. Отчёт Traccar здесь непригоден:
   * он опирается на attributes.motion, а Teltonika держит его true от вибрации
   * работающего двигателя — машина час стоит с заведённым мотором, а поездка
   * не разрывается. Считаем по скорости: остановка дольше PARKING_SEC (и разрыв
   * связи дольше GAP_SEC) заканчивает поездку; пробег — хаверсином, как в dayStats.
   */
  async trips(deviceId: number, from: Date, to: Date, options: { parkingSec?: number } = {}) {
    const MOVING_KNOTS = 2; // ~3.7 км/ч
    const MIN_TRIP_METERS = 100;
    const GAP_SEC = 600;
    const parkingSec = options.parkingSec ?? 60;

    const rows = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      WITH pts AS (
        SELECT p.fixtime, p.speed,
               p.speed > ${MOVING_KNOTS} AS moving,
               EXTRACT(EPOCH FROM (p.fixtime - LAG(p.fixtime) OVER w)) AS dt,
               2 * 6371000 * asin(LEAST(1, sqrt(
                 sin((radians(p.latitude) - radians(LAG(p.latitude) OVER w)) / 2) ^ 2
                 + cos(radians(LAG(p.latitude) OVER w)) * cos(radians(p.latitude))
                 * sin((radians(p.longitude) - radians(LAG(p.longitude) OVER w)) / 2) ^ 2
               ))) AS hop
        FROM tc_positions p
        WHERE p.deviceid = ${deviceId} AND p.valid
          AND p.fixtime >= ${from} AND p.fixtime <= ${to}
        WINDOW w AS (ORDER BY p.fixtime)
      ), flags AS (
        SELECT fixtime, speed, moving, dt,
               -- dt бывает 0 (бэклог приходит пачкой с одинаковым временем):
               -- без GREATEST защита от «телепортов» отключалась и пробег раздувался
               CASE WHEN hop IS NULL OR hop < 15
                      OR hop / GREATEST(coalesce(dt, 1), 1) > 70 THEN 0 ELSE hop END AS dist,
               CASE WHEN moving IS DISTINCT FROM LAG(moving) OVER (ORDER BY fixtime)
                      OR dt > ${GAP_SEC} THEN 1 ELSE 0 END AS newrun
        FROM pts
      ), runs0 AS (
        SELECT *, SUM(newrun) OVER (ORDER BY fixtime) AS run FROM flags
      ), runs1 AS (
        SELECT *, FIRST_VALUE(dt) OVER (PARTITION BY run ORDER BY fixtime) AS first_dt FROM runs0
      ), runs AS (
        SELECT run, bool_and(moving) AS moving, min(fixtime) AS t0, max(fixtime) AS t1,
               sum(dist) AS dist, max(speed) AS maxspeed, max(first_dt) AS gap_before
        FROM runs1 GROUP BY run
      ), marked AS (
        SELECT *,
               (NOT moving AND EXTRACT(EPOCH FROM (t1 - t0)) >= ${parkingSec}) AS is_park,
               (coalesce(gap_before, 0) > ${GAP_SEC}) AS gapped
        FROM runs
      ), numbered AS (
        SELECT *, SUM(CASE WHEN is_park OR gapped THEN 1 ELSE 0 END) OVER (ORDER BY run) AS trip_no
        FROM marked
      )
      SELECT min(t0) FILTER (WHERE moving) AS starttime,
             max(t1) FILTER (WHERE moving) AS endtime,
             sum(dist) AS distance,
             max(maxspeed) AS maxspeed
      FROM numbered
      WHERE NOT is_park
      GROUP BY trip_no
      HAVING sum(dist) >= ${MIN_TRIP_METERS}
         AND count(*) FILTER (WHERE moving) > 0
      ORDER BY 1`);

    return rows.map((r) => {
      const startTime = new Date(r.starttime);
      const endTime = new Date(r.endtime);
      const duration = endTime.getTime() - startTime.getTime();
      const distance = Math.round(Number(r.distance ?? 0));
      return {
        deviceId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        distance,
        duration,
        maxSpeed: Number(r.maxspeed ?? 0),
        averageSpeed: duration > 0 ? (distance / duration) * 3600000 / 1852 : 0,
        startAddress: null,
        endAddress: null,
      };
    });
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
