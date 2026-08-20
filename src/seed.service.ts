import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from './prisma/prisma.service';

/**
 * Идемпотентный сид при старте: базовые роли и первый администратор.
 * Пароль администратора берётся из ADMIN_PASSWORD; если переменная не задана,
 * генерируется и печатается в лог один раз.
 */
@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    const admin = await this.prisma.htRole.upsert({
      where: { name: 'admin' },
      update: {},
      create: { name: 'admin', description: 'Полный доступ', permissions: ['*'] },
    });
    await this.prisma.htRole.upsert({
      where: { name: 'client' },
      update: {},
      create: { name: 'client', description: 'Клиент — свои устройства', permissions: [] },
    });

    if ((await this.prisma.htUser.count()) === 0) {
      const email = this.config.get<string>('ADMIN_EMAIL') ?? 'admin@hitrack.am';
      let password = this.config.get<string>('ADMIN_PASSWORD');
      if (!password) {
        password = randomBytes(9).toString('base64url');
        this.logger.warn(`ADMIN_PASSWORD не задан — сгенерирован пароль администратора: ${password}`);
      }
      await this.prisma.htUser.create({
        data: {
          email,
          name: 'Administrator',
          passwordHash: await bcrypt.hash(password, 10),
          roleId: admin.id,
        },
      });
      this.logger.log(`Создан администратор ${email}`);
    }
  }
}
