-- Project 加 automationHint（项目级自动化执行约束，仅用于脚本生成和修复）。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Project' AND COLUMN_NAME = 'automationHint');
SET @sql = IF(@col <= 0, 'ALTER TABLE `Project` ADD COLUMN `automationHint` TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
