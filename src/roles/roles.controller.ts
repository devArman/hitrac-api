import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { IsArray, IsOptional, IsString, MinLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { Require } from '../auth/decorators';

class CreateRoleDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}

@Controller('roles')
@Require('roles:manage')
export class RolesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list() {
    return this.prisma.htRole.findMany({ orderBy: { id: 'asc' } });
  }

  @Post()
  create(@Body() dto: CreateRoleDto) {
    return this.prisma.htRole.create({
      data: { name: dto.name, description: dto.description, permissions: dto.permissions ?? [] },
    });
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateRoleDto) {
    return this.prisma.htRole.update({ where: { id }, data: dto });
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    const usersWithRole = await this.prisma.htUser.count({ where: { roleId: id } });
    if (usersWithRole > 0) {
      throw new ConflictException('Роль назначена пользователям — сначала сними её с них');
    }
    await this.prisma.htRole.delete({ where: { id } });
    return { deleted: true };
  }
}
