import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { AuthedUser } from './decorators';

export function publicUser(user: AuthedUser) {
  const { passwordHash, ...rest } = user;
  return rest;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.htUser.findUnique({
      where: { email: email.toLowerCase().trim() },
      include: { role: true },
    });
    if (!user || user.disabled || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Неверный email или пароль');
    }
    const accessToken = await this.jwtService.signAsync({ sub: user.id });
    return { accessToken, user: publicUser(user) };
  }
}
