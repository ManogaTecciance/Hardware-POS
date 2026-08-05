import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseInterceptors } from '@nestjs/common';

import { AuthThrottle } from '../../common/throttling/auth-throttle.decorator';
import { AuthThrottleInterceptor } from '../../common/throttling/auth-throttle.interceptor';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OptionalTenantId } from '../../common/decorators/optional-tenant-id.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { TenantId } from '../../common/decorators/tenant-id.decorator';
import { AuthenticatedUser, AuthTokenResult } from './auth.types';
import { AuthService, CurrentUserView } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { PinLoginDto } from './dto/pin-login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

/**
 * Every credential-accepting route here carries `@AuthThrottle` (Slice 7.1).
 * `auth-throttle.coverage.spec.ts` asserts the exact set, so a new route added
 * without one fails the build rather than shipping unmetered.
 */
@Controller('auth')
@UseInterceptors(AuthThrottleInterceptor)
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Email + password login (owner / admin / accountant).
   *
   * Tenant resolution, in precedence order (Slice 7.2): the `workspace` slug in the
   * body, then the `x-tenant-id` header, then a unique match on the email alone.
   * All three are client-supplied and only ever NARROW the lookup — the password is
   * always verified against the resolved user's own hash — so a wrong value can
   * only make a login fail. An email held by several workspaces returns
   * `WORKSPACE_REQUIRED` rather than picking one.
   */
  @Public()
  @AuthThrottle('email-login')
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(
    @Body() dto: LoginDto,
    @OptionalTenantId() tenantHint: string | null,
  ): Promise<AuthTokenResult> {
    return this.authService.login(dto, tenantHint);
  }

  /** PIN login (cashier / manager). Tenant comes from the x-tenant-id header. */
  @Public()
  @AuthThrottle('pin-login')
  @Post('pin-login')
  @HttpCode(HttpStatus.OK)
  pinLogin(@TenantId() tenantId: string, @Body() dto: PinLoginDto): Promise<AuthTokenResult> {
    return this.authService.pinLogin(tenantId, dto);
  }

  /**
   * Exchange a refresh token for a fresh access + refresh pair (rotation).
   * Public: this is exactly the call made once the access token has expired.
   */
  @Public()
  @AuthThrottle('refresh')
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto): Promise<AuthTokenResult> {
    return this.authService.refresh(dto.refreshToken);
  }

  /** Revoke a refresh token on sign-out. Public so an expired session can still sign out. */
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: RefreshTokenDto): Promise<void> {
    return this.authService.logout(dto.refreshToken);
  }

  /** The authenticated user plus their effective permissions. */
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): Promise<CurrentUserView> {
    return this.authService.getCurrentUser(user.id);
  }
}
