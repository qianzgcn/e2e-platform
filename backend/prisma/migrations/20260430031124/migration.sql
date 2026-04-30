/*
  Warnings:

  - The primary key for the `TestCase` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropForeignKey
ALTER TABLE `RunLog` DROP FOREIGN KEY `RunLog_testCaseId_fkey`;

-- AlterTable
ALTER TABLE `RunLog` MODIFY `testCaseId` VARCHAR(191) NOT NULL;

-- AlterTable
ALTER TABLE `TestCase` DROP PRIMARY KEY,
    MODIFY `id` VARCHAR(191) NOT NULL,
    ADD PRIMARY KEY (`id`);

-- AddForeignKey
ALTER TABLE `RunLog` ADD CONSTRAINT `RunLog_testCaseId_fkey` FOREIGN KEY (`testCaseId`) REFERENCES `TestCase`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
