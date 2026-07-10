-- Project 加 repoUrl（被测系统代码仓库地址，用于 AI 生成用例）。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Project' AND COLUMN_NAME = 'repoUrl');
SET @sql = IF(@col <= 0, 'ALTER TABLE `Project` ADD COLUMN `repoUrl` VARCHAR(500) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
