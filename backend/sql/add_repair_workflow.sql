-- 为运行日志增加任务类型、统一过程日志和修复来源。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RunLog' AND COLUMN_NAME = 'kind');
SET @sql = IF(@col <= 0, 'ALTER TABLE `RunLog` ADD COLUMN `kind` ENUM(''execution'',''repair'') NOT NULL DEFAULT ''execution'' AFTER `testCaseId`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RunLog' AND COLUMN_NAME = 'logs');
SET @sql = IF(@col <= 0, 'ALTER TABLE `RunLog` ADD COLUMN `logs` LONGTEXT NULL AFTER `failureReason`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RunLog' AND COLUMN_NAME = 'sourceRunLogId');
SET @sql = IF(@col <= 0, 'ALTER TABLE `RunLog` ADD COLUMN `sourceRunLogId` INTEGER NULL AFTER `stderr`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx = (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RunLog' AND INDEX_NAME = 'RunLog_sourceRunLogId_idx');
SET @sql = IF(@idx <= 0, 'ALTER TABLE `RunLog` ADD INDEX `RunLog_sourceRunLogId_idx` (`sourceRunLogId`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk = (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'RunLog' AND CONSTRAINT_NAME = 'RunLog_sourceRunLogId_fkey');
SET @sql = IF(@fk <= 0, 'ALTER TABLE `RunLog` ADD CONSTRAINT `RunLog_sourceRunLogId_fkey` FOREIGN KEY (`sourceRunLogId`) REFERENCES `RunLog` (`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE `RunLog`
SET `logs` = `stdout`, `stdout` = NULL
WHERE `logs` IS NULL AND `stdout` LIKE '[用例生成日志]%';

-- 扩展候选，使其既能表示新生成用例，也能表示已有用例的自然语言修复建议。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND COLUMN_NAME = 'kind');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseCandidate` ADD COLUMN `kind` ENUM(''generated'',''repair'') NOT NULL DEFAULT ''generated'' AFTER `projectId`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

ALTER TABLE `TestCaseCandidate` MODIFY COLUMN `generationId` INT NULL;
ALTER TABLE `TestCaseCandidate` MODIFY COLUMN `status` ENUM('pending','imported','rejected') NOT NULL DEFAULT 'pending';

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND COLUMN_NAME = 'repairRunLogId');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseCandidate` ADD COLUMN `repairRunLogId` INT NULL AFTER `generationId`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND COLUMN_NAME = 'targetTestCaseId');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseCandidate` ADD COLUMN `targetTestCaseId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER `repairRunLogId`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @targetCollation = (SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCase' AND COLUMN_NAME = 'id');
SET @candidateCollation = (SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND COLUMN_NAME = 'targetTestCaseId');
SET @sql = IF(
  @candidateCollation <> @targetCollation,
  CONCAT('ALTER TABLE `TestCaseCandidate` MODIFY COLUMN `targetTestCaseId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE ', @targetCollation, ' NULL'),
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND COLUMN_NAME = 'sourceNaturalLanguage');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseCandidate` ADD COLUMN `sourceNaturalLanguage` TEXT NULL AFTER `naturalLanguage`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND COLUMN_NAME = 'sourceEditedAt');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseCandidate` ADD COLUMN `sourceEditedAt` DATETIME(3) NULL AFTER `sourceNaturalLanguage`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND COLUMN_NAME = 'repairProblem');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseCandidate` ADD COLUMN `repairProblem` TEXT NULL AFTER `sourceEditedAt`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND COLUMN_NAME = 'repairSuggestion');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseCandidate` ADD COLUMN `repairSuggestion` TEXT NULL AFTER `repairProblem`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx = (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND INDEX_NAME = 'TestCaseCandidate_repairRunLogId_key');
SET @sql = IF(@idx <= 0, 'ALTER TABLE `TestCaseCandidate` ADD UNIQUE INDEX `TestCaseCandidate_repairRunLogId_key` (`repairRunLogId`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx = (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND INDEX_NAME = 'TestCaseCandidate_targetTestCaseId_idx');
SET @sql = IF(@idx <= 0, 'ALTER TABLE `TestCaseCandidate` ADD INDEX `TestCaseCandidate_targetTestCaseId_idx` (`targetTestCaseId`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk = (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND CONSTRAINT_NAME = 'TestCaseCandidate_repairRunLogId_fkey');
SET @sql = IF(@fk <= 0, 'ALTER TABLE `TestCaseCandidate` ADD CONSTRAINT `TestCaseCandidate_repairRunLogId_fkey` FOREIGN KEY (`repairRunLogId`) REFERENCES `RunLog` (`id`) ON DELETE SET NULL ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk = (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseCandidate' AND CONSTRAINT_NAME = 'TestCaseCandidate_targetTestCaseId_fkey');
SET @sql = IF(@fk <= 0, 'ALTER TABLE `TestCaseCandidate` ADD CONSTRAINT `TestCaseCandidate_targetTestCaseId_fkey` FOREIGN KEY (`targetTestCaseId`) REFERENCES `TestCase` (`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
