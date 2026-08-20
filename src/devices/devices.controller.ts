import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { DevicesService } from './devices.service';
import { TraccarService } from '../traccar/traccar.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedUser, CurrentUser, Require } from '../auth/decorators';

const REPORT_TYPES = new Set(['trips', 'route', 'summary', 'events', 'stops']);
const COMMAND_TYPES = new Set(['positionSingle', 'rebootDevice', 'engineStop', 'engineResume']);

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
  ) {}

  @Get('devices')
  devices(@CurrentUser() user: AuthedUser) {
    return this.devicesService.devices(user);
  }

  @Get('positions')
  positions(@CurrentUser() user: AuthedUser) {
    return this.devicesService.positions(user);
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
    return this.traccar.request(`/reports/${type}`, {
      params: { deviceId: ids.map(String), from, to },
    });
  }

  @Get('geofences')
  geofences() {
    return this.traccar.request('/geofences', { params: { all: 'true' } });
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
  @Post('admin/devices')
  @Require('devices:manage')
  async createDevice(@Body() dto: CreateDeviceDto) {
    const device = await this.traccar.request('/devices', {
      method: 'POST',
      body: { name: dto.name, uniqueId: dto.uniqueId, model: dto.model ?? null },
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
    @Body() dto: { name?: string; model?: string },
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
