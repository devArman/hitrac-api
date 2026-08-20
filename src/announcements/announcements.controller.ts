import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedUser, CurrentUser, Require } from '../auth/decorators';

class CreateAnnouncementDto {
  @IsString()
  @MinLength(1)
  subject: string;

  @IsString()
  @MinLength(1)
  body: string;

  @IsOptional()
  @IsBoolean()
  toAll?: boolean;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  groupIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];
}

@Controller()
export class AnnouncementsController {
  constructor(private readonly prisma: PrismaService) {}

  /** объявления, адресованные текущему пользователю (все / его группы / он сам) */
  @Get('announcements')
  async mine(@CurrentUser() user: AuthedUser) {
    const list = await this.prisma.htAnnouncement.findMany({
      where: {
        OR: [
          { toAll: true },
          { users: { some: { userId: user.id } } },
          { groups: { some: { group: { users: { some: { userId: user.id } } } } } },
        ],
      },
      include: { reads: { where: { userId: user.id } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return list.map((a) => ({
      id: a.id,
      subject: a.subject,
      body: a.body,
      createdAt: a.createdAt,
      read: a.reads.length > 0,
    }));
  }

  @Post('announcements/:id/read')
  async markRead(@CurrentUser() user: AuthedUser, @Param('id', ParseIntPipe) id: number) {
    await this.prisma.htAnnouncementRead.upsert({
      where: { announcementId_userId: { announcementId: id, userId: user.id } },
      update: {},
      create: { announcementId: id, userId: user.id },
    });
    return { read: true };
  }

  // ── админка ──

  @Get('admin/announcements')
  @Require('announcements:manage')
  async list() {
    const [list, clientsTotal] = await Promise.all([
      this.prisma.htAnnouncement.findMany({
        include: {
          groups: { include: { group: { include: { users: true } } } },
          users: { select: { userId: true } },
          reads: { select: { userId: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.htUser.count({ where: { role: { name: 'client' } } }),
    ]);
    return list.map((a) => {
      const audience = a.toAll
        ? clientsTotal
        : new Set([
          ...a.users.map((u) => u.userId),
          ...a.groups.flatMap((g) => g.group.users.map((u) => u.userId)),
        ]).size;
      return {
        id: a.id,
        subject: a.subject,
        body: a.body,
        toAll: a.toAll,
        groupIds: a.groups.map((g) => g.groupId),
        groupNames: a.groups.map((g) => g.group.name),
        userIds: a.users.map((u) => u.userId),
        createdAt: a.createdAt,
        readCount: a.reads.length,
        audienceCount: audience,
      };
    });
  }

  @Post('admin/announcements')
  @Require('announcements:manage')
  async create(@CurrentUser() user: AuthedUser, @Body() dto: CreateAnnouncementDto) {
    const announcement = await this.prisma.htAnnouncement.create({
      data: {
        subject: dto.subject,
        body: dto.body,
        toAll: dto.toAll ?? false,
        createdBy: user.id,
        groups: { create: (dto.groupIds ?? []).map((groupId) => ({ groupId })) },
        users: { create: (dto.userIds ?? []).map((userId) => ({ userId })) },
      },
    });
    return announcement;
  }

  @Delete('admin/announcements/:id')
  @Require('announcements:manage')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.htAnnouncement.delete({ where: { id } });
    return { deleted: true };
  }
}
