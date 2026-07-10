-- AI 生成用例的生成批次与候选用例。
CREATE TABLE IF NOT EXISTS `TestCaseGeneration` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `projectId` INT NOT NULL,
  `logs` TEXT NOT NULL,
  `hint` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `TestCaseGeneration_projectId_idx` (`projectId`),
  CONSTRAINT `TestCaseGeneration_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4;

CREATE TABLE IF NOT EXISTS `TestCaseCandidate` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `projectId` INT NOT NULL,
  `generationId` INT NOT NULL,
  `title` VARCHAR(191) NOT NULL,
  `groupName` VARCHAR(191) NOT NULL,
  `naturalLanguage` TEXT NOT NULL,
  `status` ENUM('pending','imported') NOT NULL DEFAULT 'pending',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `TestCaseCandidate_projectId_idx` (`projectId`),
  INDEX `TestCaseCandidate_generationId_idx` (`generationId`),
  CONSTRAINT `TestCaseCandidate_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE,
  CONSTRAINT `TestCaseCandidate_generationId_fkey` FOREIGN KEY (`generationId`) REFERENCES `TestCaseGeneration`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4;
