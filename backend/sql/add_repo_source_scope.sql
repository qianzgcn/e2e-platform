-- Project 的可选仓库分支和子目录，用于浅克隆及 sparse checkout。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Project' AND COLUMN_NAME = 'repoBranch');
SET @sql = IF(@col <= 0, 'ALTER TABLE `Project` ADD COLUMN `repoBranch` VARCHAR(255) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Project' AND COLUMN_NAME = 'repoSubdirectory');
SET @sql = IF(@col <= 0, 'ALTER TABLE `Project` ADD COLUMN `repoSubdirectory` VARCHAR(1000) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
