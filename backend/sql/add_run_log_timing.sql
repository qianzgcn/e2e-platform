-- 记录 AI 生成/修复与 Playwright 执行/验证的阶段起点，阶段终点由下一阶段或 finishedAt 确定。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RunLog' AND COLUMN_NAME = 'generationStartedAt');
SET @sql = IF(@col <= 0, 'ALTER TABLE `RunLog` ADD COLUMN `generationStartedAt` DATETIME(3) NULL AFTER `sourceRunLogId`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'RunLog' AND COLUMN_NAME = 'executionStartedAt');
SET @sql = IF(@col <= 0, 'ALTER TABLE `RunLog` ADD COLUMN `executionStartedAt` DATETIME(3) NULL AFTER `generationStartedAt`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
