-- CreateTable
CREATE TABLE `Project` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `baseUrl` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TestCase` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(191) NOT NULL,
    `groupName` VARCHAR(191) NOT NULL,
    `naturalLanguage` TEXT NOT NULL,
    `playwrightScript` LONGTEXT NULL,
    `status` ENUM('not_run', 'queued', 'generating', 'running', 'success', 'failed') NOT NULL DEFAULT 'not_run',
    `lastFailureReason` TEXT NULL,
    `lastRunAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RunLog` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `testCaseId` INTEGER NOT NULL,
    `status` ENUM('queued', 'generating', 'running', 'success', 'failed') NOT NULL,
    `failureReason` TEXT NULL,
    `stdout` LONGTEXT NULL,
    `stderr` LONGTEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `RunLog_testCaseId_idx`(`testCaseId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RunLog` ADD CONSTRAINT `RunLog_testCaseId_fkey` FOREIGN KEY (`testCaseId`) REFERENCES `TestCase`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
