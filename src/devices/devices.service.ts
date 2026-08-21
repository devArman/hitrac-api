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
   * не разрывается. Считаем по скорости: остановка дольше parkingSec (2.5 мин,
   * как в Wialon у клиента) и разрыв связи дольше GAP_SEC заканчивают поездку;
   * пробег — хаверсином, как в dayStats.
   */
  async trips(deviceId: number, from: Date, to: Date, options: { parkingSec?: number } = {}) {
    const segments = await this.timeline(deviceId, from, to, options);
    return segments
      .filter((s) => s.type === 'trip')
      .map((s) => ({
        deviceId,
        startTime: s.startTime,
        endTime: s.endTime,
        distance: s.distance,
        duration: s.duration,
        maxSpeed: s.maxSpeed,
        averageSpeed: s.averageSpeed,
        startAddress: null,
        endAddress: null,
      }));
  }

  /**
   * Лента дня: чередование поездок и стоянок (как в Wialon).
   * Куски движения между стоянками — поездки; стоянка от parkingSec, разрыв
   * связи от GAP_SEC тоже заканчивает поездку. Короткие «поездки» (<100 м)
   * считаем дрожанием GPS и присоединяем к стоянке.
   */
  async timeline(
    deviceId: number,
    from: Date,
    to: Date,
    options: { parkingSec?: number } = {},
  ): Promise<any[]> {
    const MOVING_KNOTS = 2; // ~3.7 км/ч
    const MIN_TRIP_METERS = 100;
    const GAP_SEC = 600;
    const parkingSec = options.parkingSec ?? 150; // 2.5 минуты

    const runs = await this.prisma.$queryRaw<any[]>(Prisma.sql`
      WITH pts AS (
        SELECT p.fixtime, p.speed, p.latitude, p.longitude,
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
        SELECT fixtime, speed, latitude, longitude, moving, dt,
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
        SELECT *,
               FIRST_VALUE(dt) OVER (PARTITION BY run ORDER BY fixtime) AS first_dt,
               FIRST_VALUE(latitude) OVER (PARTITION BY run ORDER BY fixtime) AS lat0,
               FIRST_VALUE(longitude) OVER (PARTITION BY run ORDER BY fixtime) AS lon0,
               LAST_VALUE(latitude) OVER (PARTITION BY run ORDER BY fixtime
                 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lat1,
               LAST_VALUE(longitude) OVER (PARTITION BY run ORDER BY fixtime
                 ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS lon1
        FROM runs0
      )
      SELECT run, bool_and(moving) AS moving, min(fixtime) AS t0, max(fixtime) AS t1,
             sum(dist) AS dist, max(speed) AS maxspeed, max(first_dt) AS gap_before,
             max(lat0) AS lat0, max(lon0) AS lon0, max(lat1) AS lat1, max(lon1) AS lon1
      FROM runs1 GROUP BY run ORDER BY min(fixtime)`);

    // склеиваем пробеги в поездки и стоянки
    const segments: any[] = [];
    let current: any = null;
    const flush = () => {
      if (!current) return;
      if (current.type === 'trip' && current.distance < MIN_TRIP_METERS) {
        // не поездка, а дрожание GPS — приклеиваем ко времени стоянки
        const prev = segments[segments.length - 1];
        if (prev?.type === 'park') {
          prev.endTime = current.endTime;
          prev.duration = new Date(prev.endTime).getTime() - new Date(prev.startTime).getTime();
          current = null;
          return;
        }
        current.type = 'park';
        current.distance = 0;
      }
      const prev = segments[segments.length - 1];
      if (prev && prev.type === current.type) {
        prev.endTime = current.endTime;
        prev.duration = new Date(prev.endTime).getTime() - new Date(prev.startTime).getTime();
        prev.distance = (prev.distance ?? 0) + (current.distance ?? 0);
        prev.maxSpeed = Math.max(prev.maxSpeed ?? 0, current.maxSpeed ?? 0);
        prev.endLat = current.endLat;
        prev.endLon = current.endLon;
      } else {
        segments.push(current);
      }
      current = null;
    };

    for (const run of runs) {
      const t0 = new Date(run.t0);
      const t1 = new Date(run.t1);
      const durationSec = (t1.getTime() - t0.getTime()) / 1000;
      const moving = Boolean(run.moving);
      const isPark = !moving && durationSec >= parkingSec;
      const gapped = Number(run.gap_before ?? 0) > GAP_SEC;
      const type = isPark ? 'park' : 'trip';

      if (current && (current.type !== type || gapped)) flush();
      if (!current) {
        current = {
          type,
          startTime: t0.toISOString(),
          endTime: t1.toISOString(),
          duration: t1.getTime() - t0.getTime(),
          distance: Math.round(Number(run.dist ?? 0)),
          maxSpeed: Number(run.maxspeed ?? 0),
          startLat: Number(run.lat0),
          startLon: Number(run.lon0),
          endLat: Number(run.lat1),
          endLon: Number(run.lon1),
        };
      } else {
        current.endTime = t1.toISOString();
        current.duration = t1.getTime() - new Date(current.startTime).getTime();
        current.distance += Math.round(Number(run.dist ?? 0));
        current.maxSpeed = Math.max(current.maxSpeed, Number(run.maxspeed ?? 0));
        current.endLat = Number(run.lat1);
        current.endLon = Number(run.lon1);
      }
    }
    flush();

    return segments.map((s) => ({
      ...s,
      averageSpeed: s.type === 'trip' && s.duration > 0
        ? (s.distance / s.duration) * 3600000 / 1852
        : 0,
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
