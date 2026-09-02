import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';

const PUBLIC_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  disabled: true,
  monthlyPrice: true,
  roleId: true,
  role: true,
  devices: { select: { deviceId: true } },
  createdAt: true,
  updatedAt: true,
} as const;

export interface UserInput {
  email?: string;
  name?: string;
  phone?: string;
  password?: string;
  roleId?: number | null;
  roleName?: string;
  disabled?: boolean;
  monthlyPrice?: number | null;
  deviceIds?: number[];
}

const shape = (user: any) => ({ ...user, deviceIds: user.devices.map((d: any) => d.deviceId), devices: undefined });

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const users = await this.prisma.htUser.findMany({ select: PUBLIC_SELECT, orderBy: { id: 'asc' } });
    return users.map(shape);
  }

  private async resolveRoleId(input: UserInput): Promise<number | null | undefined> {
    if (input.roleName) {
      const role = await this.prisma.htRole.findUnique({ where: { name: input.roleName } });
      if (!role) throw new NotFoundException(`Роль ${input.roleName} не найдена`);
      return role.id;
    }
    return input.roleId;
  }

  async create(input: Required<Pick<UserInput, 'email' | 'name' | 'password'>> & UserInput) {
    const email = input.email.toLowerCase().trim();
    if (await this.prisma.htUser.findUnique({ where: { email } })) {
      throw new ConflictException('Пользователь с таким email уже существует');
    }
    const roleId = await this.resolveRoleId(input);
    const user = await this.prisma.htUser.create({
      data: {
        email,
        name: input.name,
        phone: input.phone ?? null,
        passwordHash: await bcrypt.hash(input.password, 10),
        roleId: roleId ?? null,
        disabled: input.disabled ?? false,
        monthlyPrice: input.monthlyPrice ?? null,
        devices: { create: (input.deviceIds ?? []).map((deviceId) => ({ deviceId })) },
      },
      select: PUBLIC_SELECT,
    });
    return shape(user);
  }

  async update(id: number, input: UserInput) {
    if (!(await this.prisma.htUser.findUnique({ where: { id } }))) {
      throw new NotFoundException('Пользователь не найден');
    }
    const roleId = await this.resolveRoleId(input);
    const user = await this.prisma.htUser.update({
      where: { id },
      data: {
        ...(input.email !== undefined && { email: input.email.toLowerCase().trim() }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.password !== undefined && { passwordHash: await bcrypt.hash(input.password, 10) }),
        ...(roleId !== undefined && { roleId }),
        ...(input.disabled !== undefined && { disabled: input.disabled }),
        ...(input.monthlyPrice !== undefined && { monthlyPrice: input.monthlyPrice }),
        ...(input.deviceIds !== undefined && {
          devices: {
            deleteMany: {},
            create: input.deviceIds.map((deviceId) => ({ deviceId })),
          },
        }),
      },
      select: PUBLIC_SELECT,
    });
    return shape(user);
  }
}
