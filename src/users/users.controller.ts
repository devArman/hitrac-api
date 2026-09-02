import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { IsArray, IsBoolean, IsEmail, IsInt, IsOptional, IsString, Min, MinLength, ValidateIf } from 'class-validator';
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
  @IsString()
  phone?: string;

  @IsOptional()
  @IsInt()
  roleId?: number;

  @IsOptional()
  @IsString()
  roleName?: string;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;


  // null — снять индивидуальную цену и вернуть клиента на базовый тариф
  @IsOptional()
  @ValidateIf((o) => o.monthlyPrice !== null)
  @IsInt()
  @Min(0)
  monthlyPrice?: number | null;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  deviceIds?: number[];
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
  phone?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  password?: string;

  @IsOptional()
  @IsInt()
  roleId?: number | null;

  @IsOptional()
  @IsString()
  roleName?: string;

  @IsOptional()
  @IsBoolean()
  disabled?: boolean;


  // null — снять индивидуальную цену и вернуть клиента на базовый тариф
  @IsOptional()
  @ValidateIf((o) => o.monthlyPrice !== null)
  @IsInt()
  @Min(0)
  monthlyPrice?: number | null;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  deviceIds?: number[];
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
