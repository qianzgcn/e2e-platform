-- Project 加 promptHint（项目级业务约束，用于 AI 生成用例）。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Project' AND COLUMN_NAME = 'promptHint');
SET @sql = IF(@col <= 0, 'ALTER TABLE `Project` ADD COLUMN `promptHint` TEXT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
