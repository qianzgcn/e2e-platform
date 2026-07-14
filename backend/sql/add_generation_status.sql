-- 为 AI 用例生成批次增加可轮询状态；已有批次均由旧同步流程生成，因此默认视为成功。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGeneration' AND COLUMN_NAME = 'status');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseGeneration` ADD COLUMN `status` ENUM(''running'',''success'',''failed'') NOT NULL DEFAULT ''success'' AFTER `projectId`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @data_type = (SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGeneration' AND COLUMN_NAME = 'logs');
SET @sql = IF(@data_type <> 'longtext', 'ALTER TABLE `TestCaseGeneration` MODIFY COLUMN `logs` LONGTEXT NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGeneration' AND COLUMN_NAME = 'failureReason');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseGeneration` ADD COLUMN `failureReason` TEXT NULL AFTER `hint`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGeneration' AND COLUMN_NAME = 'finishedAt');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseGeneration` ADD COLUMN `finishedAt` DATETIME(3) NULL AFTER `createdAt`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
