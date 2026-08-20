import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsArray, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { Require } from '../auth/decorators';

class CreateGroupDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  deviceIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];
}

class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  deviceIds?: number[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  userIds?: number[];
}

const INCLUDE = {
  devices: { select: { deviceId: true } },
  users: { select: { userId: true } },
} as const;

const shape = (group: any) => ({
  id: group.id,
  name: group.name,
  description: group.description,
  createdAt: group.createdAt,
  deviceIds: group.devices.map((d: any) => d.deviceId),
  userIds: group.users.map((u: any) => u.userId),
});

@Controller('groups')
@Require('groups:manage')
export class GroupsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const groups = await this.prisma.htGroup.findMany({ include: INCLUDE, orderBy: { name: 'asc' } });
    return groups.map(shape);
  }

  @Post()
  async create(@Body() dto: CreateGroupDto) {
    const group = await this.prisma.htGroup.create({
      data: {
        name: dto.name,
        description: dto.description,
        devices: { create: (dto.deviceIds ?? []).map((deviceId) => ({ deviceId })) },
        users: { create: (dto.userIds ?? []).map((userId) => ({ userId })) },
      },
      include: INCLUDE,
    });
    return shape(group);
  }

  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateGroupDto) {
    const group = await this.prisma.htGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.deviceIds !== undefined && {
          devices: { deleteMany: {}, create: dto.deviceIds.map((deviceId) => ({ deviceId })) },
        }),
        ...(dto.userIds !== undefined && {
          users: { deleteMany: {}, create: dto.userIds.map((userId) => ({ userId })) },
        }),
      },
      include: INCLUDE,
    });
    return shape(group);
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.prisma.htGroup.delete({ where: { id } });
    return { deleted: true };
  }
}
