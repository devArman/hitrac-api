import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsArray, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { Prisma } from '@prisma/client';
import { DevicesService } from './devices.service';
import { TraccarService } from '../traccar/traccar.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeocodeService } from './geocode.service';
import { AuthedUser, CurrentUser, Require } from '../auth/decorators';

const REPORT_TYPES = new Set(['trips', 'route', 'summary', 'events', 'stops']);

// позиция годится для трека: валидный фикс с координатами в допустимых пределах и не 0/0
function isDrawablePosition(p: any): boolean {
  const lat = Number(p?.latitude);
  const lon = Number(p?.longitude);
  if (p?.valid === false) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
  return !(lat === 0 && lon === 0);
}
const COMMAND_TYPES = new Set(['positionSingle', 'rebootDevice', 'engineStop', 'engineResume']);

/** поездка через полночь попадает в два суточных окна — склеиваем обратно */
function mergeSplitTrips(rows: any[]) {
  const merged: any[] = [];
  for (const trip of rows) {
    const prev = merged[merged.length - 1];
    const gap = prev && prev.deviceId === trip.deviceId
      ? new Date(trip.startTime).getTime() - new Date(prev.endTime).getTime()
      : Infinity;
    if (gap >= 0 && gap <= 2000) {
      prev.endTime = trip.endTime;
      prev.endAddress = trip.endAddress ?? prev.endAddress;
      prev.endLat = trip.endLat ?? prev.endLat;
      prev.endLon = trip.endLon ?? prev.endLon;
      prev.endOdometer = trip.endOdometer ?? prev.endOdometer;
      prev.distance = (prev.distance ?? 0) + (trip.distance ?? 0);
      prev.duration = (prev.duration ?? 0) + (trip.duration ?? 0);
      prev.maxSpeed = Math.max(prev.maxSpeed ?? 0, trip.maxSpeed ?? 0);
      prev.spentFuel = (prev.spentFuel ?? 0) + (trip.spentFuel ?? 0);
      prev.averageSpeed = prev.duration
        ? (prev.distance / prev.duration) * 3600000 / 1852
        : prev.averageSpeed;
    } else {
      merged.push({ ...trip });
    }
  }
  return merged;
}

class SaveMyGroupDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  deviceIds?: number[];
}

class SendCommandDto {
  @IsInt()
  deviceId: number;

  @IsString()
  type: string;
}

class CreateDeviceDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(4)
  uniqueId: string;

  @IsOptional()
  @IsString()
  model?: string;

  // тип объекта: bicycle | moped | car | truck | boat (иконка в интерфейсах)
  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsInt()
  userId?: number;
}

@Controller()
export class DevicesController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly traccar: TraccarService,
    private readonly prisma: PrismaService,
    private readonly geocode: GeocodeService,
  ) {}

  @Get('devices')
  devices(@CurrentUser() user: AuthedUser) {
    return this.devicesService.devices(user);
  }

  @Get('positions')
  positions(@CurrentUser() user: AuthedUser) {
    return this.devicesService.positions(user);
  }

  // статистика за период (пробег, макс. скорость, превышения):
  // по умолчанию с начала суток по всем устройствам; deviceId — по одному
  @Get('device-stats')
  async deviceStats(
    @CurrentUser() user: AuthedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('deviceId') deviceId?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = to ? new Date(to) : new Date();
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('Неверный параметр from/to');
    }
    let only: number[] | null = null;
    if (deviceId) {
      const id = Number(deviceId);
      await this.devicesService.assertAllowed(user, [id]);
      only = [id];
    }
    return this.devicesService.dayStats(user, fromDate, toDate, only);
  }

  // лента дня: чередование поездок и стоянок с адресами (как в Wialon)
  @Get('device-timeline')
  async deviceTimeline(
    @CurrentUser() user: AuthedUser,
    @Query('deviceId') deviceId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (!deviceId || !from || !to) throw new BadRequestException('Нужны deviceId, from, to');
    const id = Number(deviceId);
    await this.devicesService.assertAllowed(user, [id]);
    const segments = await this.devicesService.timeline(id, new Date(from), new Date(to));
    // адрес нужен там, где машина стояла
    const parks = segments.filter((s) => s.type === 'park');
    const addresses = await this.geocode.lookupMany(
      parks.map((s) => ({ lat: s.startLat, lon: s.startLon })),
    );
    parks.forEach((s, i) => { s.address = addresses[i]; });
    return segments;
  }

  // группы для фильтров в кабинетах: админские (общие) + личные группы
  // пользователя; из админских видны только устройства, доступные пользователю
  @Get('device-groups')
  async deviceGroups(@CurrentUser() user: AuthedUser) {
    const allowed = await this.devicesService.allowedIds(user);
    const allowedSet = allowed === null ? null : new Set(allowed);
    const groups = await this.prisma.htGroup.findMany({
      where: { OR: [{ ownerUserId: null }, { ownerUserId: user.id }] },
      include: { devices: { select: { deviceId: true } } },
      orderBy: { name: 'asc' },
    });
    return groups
      .map((g) => ({
        id: g.id,
        name: g.name,
        own: g.ownerUserId === user.id,
        deviceIds: g.devices
          .map((d) => d.deviceId)
          .filter((id) => allowedSet === null || allowedSet.has(id)),
      }))
      .filter((g) => g.own || g.deviceIds.length > 0);
  }

  // личные группы клиента: создание/правка/удаление только своих,
  // устройства — только из доступных пользователю
  @Post('device-groups')
  async createMyGroup(@CurrentUser() user: AuthedUser, @Body() dto: SaveMyGroupDto) {
    const deviceIds = [...new Set(dto.deviceIds ?? [])];
    if (deviceIds.length) await this.devicesService.assertAllowed(user, deviceIds);
    const group = await this.prisma.htGroup.create({
      data: {
        name: dto.name.trim(),
        ownerUserId: user.id,
        devices: { create: deviceIds.map((deviceId) => ({ deviceId })) },
      },
      include: { devices: { select: { deviceId: true } } },
    });
    return { id: group.id, name: group.name, own: true, deviceIds: group.devices.map((d) => d.deviceId) };
  }

  @Patch('device-groups/:id')
  async updateMyGroup(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SaveMyGroupDto,
  ) {
    const found = await this.prisma.htGroup.findUnique({ where: { id } });
    if (!found || found.ownerUserId !== user.id) {
      throw new BadRequestException('Можно менять только свои группы');
    }
    const deviceIds = [...new Set(dto.deviceIds ?? [])];
    if (deviceIds.length) await this.devicesService.assertAllowed(user, deviceIds);
    const group = await this.prisma.htGroup.update({
      where: { id },
      data: {
        name: dto.name.trim(),
        devices: { deleteMany: {}, create: deviceIds.map((deviceId) => ({ deviceId })) },
      },
      include: { devices: { select: { deviceId: true } } },
    });
    return { id: group.id, name: group.name, own: true, deviceIds: group.devices.map((d) => d.deviceId) };
  }

  @Delete('device-groups/:id')
  async deleteMyGroup(@CurrentUser() user: AuthedUser, @Param('id', ParseIntPipe) id: number) {
    const found = await this.prisma.htGroup.findUnique({ where: { id } });
    if (!found || found.ownerUserId !== user.id) {
      throw new BadRequestException('Можно удалять только свои группы');
    }
    await this.prisma.htGroup.delete({ where: { id } });
    return { deleted: true };
  }

  // отчёты считает движок Traccar — проксируем под служебным аккаунтом,
  // проверив доступ пользователя к каждому устройству
  @Get('reports/:type')
  async report(
    @CurrentUser() user: AuthedUser,
    @Param('type') type: string,
    @Query('deviceId') deviceId: string | string[],
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    if (!REPORT_TYPES.has(type)) throw new BadRequestException('Неизвестный тип отчёта');
    if (!deviceId || !from || !to) throw new BadRequestException('Нужны deviceId, from, to');
    const ids = (Array.isArray(deviceId) ? deviceId : [deviceId]).map(Number);
    await this.devicesService.assertAllowed(user, ids);
    // поездки считаем сами из позиций: детектор Traccar верит attributes.motion,
    // который Teltonika держит true от вибрации двигателя (см. DevicesService.trips)
    if (type === 'trips') {
      const perDevice = await Promise.all(
        ids.map((id) => this.devicesService.trips(id, new Date(from), new Date(to))),
      );
      return perDevice.flat().sort(
        (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
      );
    }
    // стоянки на периоде длиннее суток Traccar отдаёт пустыми — режем на суточные окна
    if (type === 'stops') {
      return this.chunkedReport(type, ids, new Date(from), new Date(to));
    }
    const rows = await this.traccar.request(`/reports/${type}`, {
      params: { deviceId: ids.map(String), from, to },
    });
    // трек: Traccar отдаёт и невалидные фиксы (valid=false, координаты 0/0) —
    // на карте они рисуются прямой через полмира к «нулевому острову» в Гвинейском заливе
    return type === 'route' && Array.isArray(rows) ? rows.filter(isDrawablePosition) : rows;
  }

  private async chunkedReport(type: string, ids: number[], from: Date, to: Date) {
    const DAY = 24 * 3600 * 1000;
    const windows: Array<[Date, Date]> = [];
    for (let start = from.getTime(); start < to.getTime(); start += DAY) {
      windows.push([new Date(start), new Date(Math.min(start + DAY - 1000, to.getTime()))]);
    }
    if (windows.length === 0) return [];

    const rows: any[] = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < windows.length; i += CONCURRENCY) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await Promise.all(windows.slice(i, i + CONCURRENCY).map(([a, b]) =>
        this.traccar.request(`/reports/${type}`, {
          params: { deviceId: ids.map(String), from: a.toISOString(), to: b.toISOString() },
        }).catch(() => [])));
      batch.forEach((part) => rows.push(...(part ?? [])));
    }

    rows.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    return type === 'trips' ? mergeSplitTrips(rows) : rows;
  }

  // геозоны: общие (owner null) + личные текущего пользователя
  @Get('geofences')
  async geofences(@CurrentUser() user: AuthedUser) {
    const [list, meta] = await Promise.all([
      this.traccar.request('/geofences', { params: { all: 'true' } }),
      this.prisma.htGeofenceMeta.findMany(),
    ]);
    const metaById = new Map(meta.map((m) => [m.geofenceId, m]));
    const isAdmin = user.role?.permissions.includes('*');
    return (list as any[])
      .filter((g) => {
        const m = metaById.get(g.id);
        const owner = m?.ownerUserId ?? null;
        return isAdmin || owner === null || owner === user.id;
      })
      .map((g) => {
        const owner = metaById.get(g.id)?.ownerUserId ?? null;
        return { ...g, shared: owner === null, own: owner === user.id, ownerUserId: owner };
      });
  }

  // создать геозону: у клиента — личная, у админа — общая; привязываем к устройствам,
  // чтобы движок Traccar генерил события въезда/выезда
  @Post('geofences')
  async createGeofence(
    @CurrentUser() user: AuthedUser,
    @Body() dto: { name: string; area: string },
  ) {
    if (!dto.name?.trim() || !/^(POLYGON|CIRCLE|LINESTRING)/i.test(dto.area ?? '')) {
      throw new BadRequestException('Нужны name и area (POLYGON/CIRCLE)');
    }
    if (dto.area.length > 4000) {
      throw new BadRequestException('Слишком сложная геозона — уменьшите число точек (лимит ~200)');
    }
    const geofence = await this.traccar.request('/geofences', {
      method: 'POST',
      body: { name: dto.name.trim(), area: dto.area },
    });
    const isAdmin = user.role?.permissions.includes('*');
    await this.prisma.htGeofenceMeta.create({
      data: { geofenceId: geofence.id, ownerUserId: isAdmin ? null : user.id },
    });
    // привязка к устройствам (общая — ко всем, личная — к устройствам клиента)
    const allowed = await this.devicesService.allowedIds(user);
    const deviceIds = allowed === null
      ? (await this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT id FROM tc_devices`)).map((d) => d.id)
      : allowed;
    for (const deviceId of deviceIds) {
      // по одной паре за запрос — так требует Traccar
      // eslint-disable-next-line no-await-in-loop
      await this.traccar.request('/permissions', {
        method: 'POST',
        body: { deviceId, geofenceId: geofence.id },
      }).catch(() => undefined);
    }
    return { ...geofence, shared: isAdmin, own: !isAdmin };
  }

  @Delete('geofences/:id')
  async deleteGeofence(@CurrentUser() user: AuthedUser, @Param('id', ParseIntPipe) id: number) {
    const meta = await this.prisma.htGeofenceMeta.findUnique({ where: { geofenceId: id } });
    const isAdmin = user.role?.permissions.includes('*');
    if (!isAdmin && meta?.ownerUserId !== user.id) {
      throw new BadRequestException('Можно удалять только свои геозоны');
    }
    await this.traccar.request(`/geofences/${id}`, { method: 'DELETE' });
    await this.prisma.htGeofenceMeta.deleteMany({ where: { geofenceId: id } });
    return { deleted: true };
  }

  @Get('commands/types')
  async commandTypes(@CurrentUser() user: AuthedUser, @Query('deviceId') deviceId: string) {
    const id = Number(deviceId);
    await this.devicesService.assertAllowed(user, [id]);
    return this.traccar.request('/commands/types', { params: { deviceId: String(id), textChannel: 'false' } });
  }

  @Post('commands/send')
  async sendCommand(@CurrentUser() user: AuthedUser, @Body() dto: SendCommandDto) {
    if (!COMMAND_TYPES.has(dto.type)) throw new BadRequestException('Неизвестная команда');
    await this.devicesService.assertAllowed(user, [dto.deviceId]);
    await this.traccar.request('/commands/send', {
      method: 'POST',
      body: { deviceId: dto.deviceId, type: dto.type, attributes: {} },
    });
    return { sent: true };
  }

  // создание трекера (админка): в Traccar + привязка в нашей карте прав
  // дата, с которой трекер работает: его первый пакет.
  // Отдельным админским эндпоинтом, а не в /devices — этот список клиенты тянут каждые 30 с,
  // и лишний проход по tc_positions им ни к чему.
  @Get('admin/device-first-seen')
  @Require('devices:manage')
  deviceFirstSeen() {
    // fixtime проиндексирован парой (deviceid, fixtime), поэтому MIN по устройству дешёвый;
    // мусорные 1970-е, которые шлют некоторые прошивки до первого фикса, отсекаем
    return this.prisma.$queryRaw<any[]>(Prisma.sql`
      SELECT d.id AS "deviceId", f.t AS "firstSeen"
      FROM tc_devices d
      LEFT JOIN LATERAL (
        SELECT MIN(p.fixtime) AS t
        FROM tc_positions p
        WHERE p.deviceid = d.id AND p.fixtime > TIMESTAMP '2000-01-01'
      ) f ON TRUE`);
  }

  @Post('admin/devices')
  @Require('devices:manage')
  async createDevice(@Body() dto: CreateDeviceDto) {
    const device = await this.traccar.request('/devices', {
      method: 'POST',
      body: { name: dto.name, uniqueId: dto.uniqueId, model: dto.model ?? null, category: dto.category ?? null },
    });
    if (dto.userId) {
      await this.prisma.htUserDevice.create({ data: { userId: dto.userId, deviceId: device.id } });
    }
    return device;
  }

  // правка трекера (название, модель): Traccar PUT требует полный объект
  @Patch('admin/devices/:id')
  @Require('devices:manage')
  async updateDevice(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { name?: string; model?: string; category?: string },
  ) {
    const found = await this.traccar.request('/devices', { params: { id: String(id) } });
    const device = Array.isArray(found) ? found[0] : null;
    if (!device) throw new NotFoundException('Устройство не найдено');
    return this.traccar.request(`/devices/${id}`, {
      method: 'PUT',
      body: {
        ...device,
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.model !== undefined && { model: dto.model || null }),
        ...(dto.category !== undefined && { category: dto.category || null }),
      },
    });
  }

  // лимиты текущего пользователя по его устройствам
  @Get('device-settings')
  async deviceSettings(@CurrentUser() user: AuthedUser) {
    const allowed = await this.devicesService.allowedIds(user);
    return this.prisma.htDeviceSetting.findMany({
      where: allowed === null ? {} : { deviceId: { in: allowed } },
    });
  }

  @Post('device-settings/:deviceId')
  async saveDeviceSettings(
    @CurrentUser() user: AuthedUser,
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @Body() dto: { speedLimitKmh?: number | null; minFuelLiters?: number | null },
  ) {
    await this.devicesService.assertAllowed(user, [deviceId]);
    const speedLimitKmh = dto.speedLimitKmh == null || !Number.isFinite(dto.speedLimitKmh) || dto.speedLimitKmh <= 0
      ? null : dto.speedLimitKmh;
    const minFuelLiters = dto.minFuelLiters == null || !Number.isFinite(dto.minFuelLiters) || dto.minFuelLiters <= 0
      ? null : dto.minFuelLiters;

    // лимит скорости уходит в Traccar (атрибут speedLimit в узлах) —
    // события deviceOverspeed генерит его движок
    const found = await this.traccar.request('/devices', { params: { id: String(deviceId) } });
    const device = Array.isArray(found) ? found[0] : null;
    if (device) {
      const attributes = { ...(device.attributes ?? {}) };
      if (speedLimitKmh) attributes.speedLimit = speedLimitKmh / 1.852;
      else delete attributes.speedLimit;
      await this.traccar.request(`/devices/${deviceId}`, { method: 'PUT', body: { ...device, attributes } });
    }

    return this.prisma.htDeviceSetting.upsert({
      where: { deviceId },
      update: { speedLimitKmh, minFuelLiters, ...(minFuelLiters == null ? { fuelAlerted: false } : {}) },
      create: { deviceId, speedLimitKmh, minFuelLiters },
    });
  }

  // наши автоматические уведомления (низкое топливо) по устройствам пользователя
  @Get('alerts')
  async alerts(
    @CurrentUser() user: AuthedUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('deviceId') deviceId?: string,
  ) {
    const allowed = await this.devicesService.allowedIds(user);
    const ids = deviceId ? [Number(deviceId)] : allowed;
    if (deviceId) await this.devicesService.assertAllowed(user, [Number(deviceId)]);
    return this.prisma.htAlert.findMany({
      where: {
        ...(ids === null ? {} : { deviceId: { in: ids } }),
        createdAt: {
          gte: from ? new Date(from) : new Date(Date.now() - 7 * 86400000),
          ...(to ? { lte: new Date(to) } : {}),
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  @Get('admin/fuel-calibrations')
  @Require('devices:manage')
  fuelCalibrations() {
    return this.prisma.htFuelCalibration.findMany();
  }

  // сохранить/обновить тарировку; пустой список точек — удалить
  @Post('admin/fuel-calibrations/:deviceId')
  @Require('devices:manage')
  async saveFuelCalibration(
    @Param('deviceId', ParseIntPipe) deviceId: number,
    @Body() dto: { sensorKey?: string; points: Array<{ raw: number; liters: number }> },
  ) {
    const points = (dto.points ?? [])
      .filter((p) => Number.isFinite(p.raw) && Number.isFinite(p.liters))
      .sort((a, b) => a.raw - b.raw);
    if (points.length < 2) {
      await this.prisma.htFuelCalibration.deleteMany({ where: { deviceId } });
      return { deleted: true };
    }
    const sensorKey = dto.sensorKey || 'io270';
    return this.prisma.htFuelCalibration.upsert({
      where: { deviceId },
      update: { sensorKey, points },
      create: { deviceId, sensorKey, points },
    });
  }

  @Get('admin/statistics')
  @Require('platform:manage')
  statistics(@Query('from') from: string, @Query('to') to: string) {
    return this.traccar.request('/statistics', { params: { from, to } });
  }
}
