import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { HtRole, HtUser } from '@prisma/client';

export const IS_PUBLIC_KEY = 'isPublic';
/** Эндпоинт доступен без токена (health, login). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const PERMISSION_KEY = 'requiredPermission';
/** Требуемое право, например `Require('users:manage')`. Роль с "*" проходит всегда. */
export const Require = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

export type AuthedUser = HtUser & { role: HtRole | null };

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser => ctx.switchToHttp().getRequest().user,
);
