import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

const CODE = /^[A-Z][A-Z0-9-]*$/;

export class CreatePrinterDto {
  @IsString() @Length(2, 32) @Matches(CODE, {
    message: 'code must be upper-case alphanumeric with hyphens',
  })
  code!: string;
  @IsString() @Length(1, 80) name!: string;
  @IsIn(['ESC_POS_NETWORK', 'ESC_POS_USB', 'A4_NETWORK', 'MOCK']) kind!: string;
  @IsString() @Length(1, 200) address!: string;
}

export class UpdatePrinterDto {
  @IsOptional() @IsString() @Length(1, 80) name?: string;
  @IsOptional() @IsIn(['ESC_POS_NETWORK', 'ESC_POS_USB', 'A4_NETWORK', 'MOCK']) kind?: string;
  @IsOptional() @IsString() @Length(1, 200) address?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class MarkPrintedDto {
  @IsString() @Length(1, 128) printerId!: string;
}

export class MarkFailedDto {
  @IsString() @Length(1, 128) printerId!: string;
  @IsString() @Length(1, 500) error!: string;
}
