-- CreateEnum
CREATE TYPE "QuantityType" AS ENUM ('WHOLE', 'DECIMAL');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "quantityType" "QuantityType" NOT NULL DEFAULT 'WHOLE',
ADD COLUMN     "unitOfMeasure" TEXT;
