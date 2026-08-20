import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

const PUBLIC_SELECT = {
  id: true,
  email: true,
  name: true,
  disabled: true,
  roleId: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

export interface UserInput {
  email?: string;
  name?: string;
  password?: string;
  roleId?: number | null;
  disabled?: boolean;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.htUser.findMany({ select: PUBLIC_SELECT, orderBy: { id: 'asc' } });
  }

  async create(input: Required<Pick<UserInput, 'email' | 'name' | 'password'>> & UserInput) {
    const email = input.email.toLowerCase().trim();
    if (await this.prisma.htUser.findUnique({ where: { email } })) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }
    return this.prisma.htUser.create({
      data: {
        email,
        name: input.name,
        passwordHash: await bcrypt.hash(input.password, 10),
        roleId: input.roleId ?? null,
        disabled: input.disabled ?? false,
      },
      select: PUBLIC_SELECT,
    });
  }

  async update(id: number, input: UserInput) {
    if (!(await this.prisma.htUser.findUnique({ where: { id } }))) {
      throw new NotFoundException('Пользователь не найден');
    }
    return this.prisma.htUser.update({
      where: { id },
      data: {
        ...(input.email !== undefined && { email: input.email.toLowerCase().trim() }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.password !== undefined && { passwordHash: await bcrypt.hash(input.password, 10) }),
        ...(input.roleId !== undefined && { roleId: input.roleId }),
        ...(input.disabled !== undefined && { disabled: input.disabled }),
      },
      select: PUBLIC_SELECT,
    });
  }
}
