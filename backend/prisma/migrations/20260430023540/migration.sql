/*
  Warnings:

  - You are about to drop the column `groupName` on the `TestCase` table. All the data in the column will be lost.
  - Added the required column `groupId` to the `TestCase` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `TestCase` DROP COLUMN `groupName`,
    ADD COLUMN `groupId` INTEGER NOT NULL;

-- CreateTable
CREATE TABLE `TestCaseGroup` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TestCaseGroup_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `TestCase_groupId_idx` ON `TestCase`(`groupId`);

-- AddForeignKey
ALTER TABLE `TestCase` ADD CONSTRAINT `TestCase_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `TestCaseGroup`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
