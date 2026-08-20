import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthedUser, PERMISSION_KEY } from './decorators';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) {
      return true;
    }

    const user: AuthedUser | undefined = context.switchToHttp().getRequest().user;
    const permissions = user?.role?.permissions ?? [];
    if (permissions.includes('*') || permissions.includes(required)) {
      return true;
    }
    throw new ForbiddenException(`Требуется право: ${required}`);
  }
}
