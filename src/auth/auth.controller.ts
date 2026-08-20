import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { AuthService, publicUser } from './auth.service';
import { AuthedUser, CurrentUser, Public } from './decorators';

class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  password: string;
}

@Controller()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

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
}
