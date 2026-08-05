import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { ThrottlingModule } from '../../common/throttling/throttling.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';

@Module({
  imports: [
    // Imported explicitly even though ThrottlingModule is @Global: globality only
    // applies once a module is in the application graph, so an isolated
    // TestingModule that pulls in AuthModule alone would otherwise fail to resolve
    // AuthThrottleInterceptor. Declaring the dependency is also simply honest —
    // AuthController genuinely uses it.
    ThrottlingModule,
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        // expiresIn accepts a `ms` string (e.g. "12h") or seconds; ConfigService
        // returns a plain string, so narrow it for the vendor's template type.
        signOptions: {
          expiresIn: config.get<string>('JWT_EXPIRES_IN', '12h') as unknown as number,
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository],
  exports: [AuthService],
})
export class AuthModule {}
