import { IsBoolean } from 'class-validator';

/** Tick a credit invoice off as paid, or clear the tick. */
export class MarkSalePaidDto {
  @IsBoolean()
  marked!: boolean;
}
