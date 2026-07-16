-- Project 加 automationAdapterKey（选择平台内已安装的项目级自动化 Adapter）。
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Project' AND COLUMN_NAME = 'automationAdapterKey');
SET @sql = IF(@col <= 0, 'ALTER TABLE `Project` ADD COLUMN `automationAdapterKey` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
