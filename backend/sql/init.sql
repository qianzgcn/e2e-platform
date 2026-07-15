CREATE TABLE IF NOT EXISTS `Project` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `baseUrl` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `TestCaseGroup` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  UNIQUE INDEX `TestCaseGroup_name_key` (`name`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ProjectVariable` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `projectId` INTEGER NOT NULL,
  `name` VARCHAR(191) NOT NULL,
  `value` TEXT NOT NULL,
  `description` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `ProjectVariable_projectId_idx` (`projectId`),
  UNIQUE INDEX `ProjectVariable_projectId_name_key` (`projectId`, `name`),
  CONSTRAINT `ProjectVariable_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `TestCase` (
  `id` VARCHAR(191) NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `groupId` INTEGER NOT NULL,
  `naturalLanguage` TEXT NOT NULL,
  `playwrightScript` LONGTEXT NULL,
  `scriptNeedsGeneration` BOOLEAN NOT NULL DEFAULT TRUE,
  `status` ENUM('not_run', 'queued', 'generating', 'running', 'success', 'failed') NOT NULL DEFAULT 'not_run',
  `lastFailureReason` TEXT NULL,
  `lastRunAt` DATETIME(3) NULL,
  `scriptGeneratedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `editedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `TestCase_groupId_idx` (`groupId`),
  CONSTRAINT `TestCase_groupId_fkey` FOREIGN KEY (`groupId`) REFERENCES `TestCaseGroup` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `RunLog` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `testCaseId` VARCHAR(191) NOT NULL,
  `kind` ENUM('execution', 'repair') NOT NULL DEFAULT 'execution',
  `status` ENUM('queued', 'generating', 'running', 'success', 'failed') NOT NULL,
  `failureReason` TEXT NULL,
  `logs` LONGTEXT NULL,
  `stdout` LONGTEXT NULL,
  `stderr` LONGTEXT NULL,
  `sourceRunLogId` INTEGER NULL,
  `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finishedAt` DATETIME(3) NULL,
  INDEX `RunLog_testCaseId_idx` (`testCaseId`),
  INDEX `RunLog_sourceRunLogId_idx` (`sourceRunLogId`),
  CONSTRAINT `RunLog_testCaseId_fkey` FOREIGN KEY (`testCaseId`) REFERENCES `TestCase` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `RunLog_sourceRunLogId_fkey` FOREIGN KEY (`sourceRunLogId`) REFERENCES `RunLog` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
