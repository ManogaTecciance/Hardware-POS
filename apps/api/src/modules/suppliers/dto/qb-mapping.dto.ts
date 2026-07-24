import { IsNotEmpty, IsString } from 'class-validator';

export class MapQbVendorDto {
  @IsString()
  @IsNotEmpty()
  vendorId!: string;
}
