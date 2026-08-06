import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';

const STATION_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Upper-snake-case identifier, unique per branch. Matches the convention role
 * keys use — an immutable machine identifier separate from the display name.
 */
export class CreateKitchenStationDto {
  @IsString()
  @Length(2, 32)
  @Matches(STATION_CODE, {
    message: 'code must be upper-snake-case starting with a letter',
  })
  code!: string;

  @IsString()
  @Length(1, 80)
  name!: string;

  @IsOptional()
  @IsIn(['KITCHEN', 'BAR', 'GRILL', 'COLD', 'DESSERT'])
  category?: string;
}

export class UpdateKitchenStationDto {
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @IsIn(['KITCHEN', 'BAR', 'GRILL', 'COLD', 'DESSERT'])
  category?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
