import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { AuthService, publicUser } from './auth.service';
import { AuthedUser, CurrentUser, Public } from './decorators';
import { PrismaService } from '../prisma/prisma.service';

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}

class UpdateMeDto {
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
}

@Controller()
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Get('me')
  me(@CurrentUser() user: AuthedUser) {
    return publicUser(user);
  }

  // пользователь правит собственный профиль (имя, телефон, пароль)
  @Patch('me')
  async updateMe(@CurrentUser() user: AuthedUser, @Body() dto: UpdateMeDto) {
    const updated = await this.prisma.htUser.update({
      where: { id: user.id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.password !== undefined && { passwordHash: await bcrypt.hash(dto.password, 10) }),
      },
      include: { role: true },
    });
    return publicUser(updated as AuthedUser);
  }
}
