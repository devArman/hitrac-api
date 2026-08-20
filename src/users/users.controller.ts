import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import { Require } from '../auth/decorators';
import { UsersService } from './users.service';

class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsOptional()
  @IsInt()
  roleId?: number;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsInt()
  roleId?: number | null;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;
}

@Controller('users')
@Require('users:manage')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list() {
    return this.usersService.list();
  }

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateUserDto) {
    return this.usersService.update(id, dto);
  }
}
