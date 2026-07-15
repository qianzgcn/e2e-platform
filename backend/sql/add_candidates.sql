-- AI 生成用例的生成批次与候选用例。
CREATE TABLE IF NOT EXISTS `TestCaseGeneration` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `projectId` INT NOT NULL,
  `status` ENUM('running','success','failed') NOT NULL DEFAULT 'success',
  `logs` LONGTEXT NOT NULL,
  `hint` TEXT NULL,
  `failureReason` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finishedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `TestCaseGeneration_projectId_idx` (`projectId`),
  CONSTRAINT `TestCaseGeneration_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `TestCaseCandidate` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `projectId` INT NOT NULL,
  `kind` ENUM('generated','repair') NOT NULL DEFAULT 'generated',
  `generationId` INT NULL,
  `repairRunLogId` INT NULL,
  `targetTestCaseId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
  `title` VARCHAR(191) NOT NULL,
  `groupName` VARCHAR(191) NOT NULL,
  `naturalLanguage` TEXT NOT NULL,
  `sourceNaturalLanguage` TEXT NULL,
  `sourceEditedAt` DATETIME(3) NULL,
  `repairProblem` TEXT NULL,
  `repairSuggestion` TEXT NULL,
  `status` ENUM('pending','imported','rejected') NOT NULL DEFAULT 'pending',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `TestCaseCandidate_projectId_idx` (`projectId`),
  INDEX `TestCaseCandidate_generationId_idx` (`generationId`),
  INDEX `TestCaseCandidate_targetTestCaseId_idx` (`targetTestCaseId`),
  UNIQUE INDEX `TestCaseCandidate_repairRunLogId_key` (`repairRunLogId`),
  CONSTRAINT `TestCaseCandidate_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE,
  CONSTRAINT `TestCaseCandidate_generationId_fkey` FOREIGN KEY (`generationId`) REFERENCES `TestCaseGeneration`(`id`) ON DELETE CASCADE,
  CONSTRAINT `TestCaseCandidate_repairRunLogId_fkey` FOREIGN KEY (`repairRunLogId`) REFERENCES `RunLog`(`id`) ON DELETE SET NULL,
  CONSTRAINT `TestCaseCandidate_targetTestCaseId_fkey` FOREIGN KEY (`targetTestCaseId`) REFERENCES `TestCase`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
