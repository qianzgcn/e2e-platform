-- 多项目改造：给 TestCase / TestCaseGroup 加 projectId，现有数据归入第一条 Project。

-- TestCase.projectId 列（先 nullable，回填后再 NOT NULL）
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCase' AND COLUMN_NAME = 'projectId');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCase` ADD COLUMN `projectId` INTEGER NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TestCaseGroup.projectId 列
SET @col = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGroup' AND COLUMN_NAME = 'projectId');
SET @sql = IF(@col <= 0, 'ALTER TABLE `TestCaseGroup` ADD COLUMN `projectId` INTEGER NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 回填：归入第一条 Project（当前项目）
UPDATE `TestCase` SET `projectId` = (SELECT `id` FROM `Project` ORDER BY `id` LIMIT 1) WHERE `projectId` IS NULL;
UPDATE `TestCaseGroup` SET `projectId` = (SELECT `id` FROM `Project` ORDER BY `id` LIMIT 1) WHERE `projectId` IS NULL;

-- 改 NOT NULL
SET @nn = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCase' AND COLUMN_NAME = 'projectId' AND IS_NULLABLE = 'YES');
SET @sql = IF(@nn > 0, 'ALTER TABLE `TestCase` MODIFY COLUMN `projectId` INTEGER NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @nn = (SELECT COUNT(1) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGroup' AND COLUMN_NAME = 'projectId' AND IS_NULLABLE = 'YES');
SET @sql = IF(@nn > 0, 'ALTER TABLE `TestCaseGroup` MODIFY COLUMN `projectId` INTEGER NOT NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 索引
SET @idx = (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCase' AND INDEX_NAME = 'TestCase_projectId_idx');
SET @sql = IF(@idx <= 0, 'CREATE INDEX `TestCase_projectId_idx` ON `TestCase`(`projectId`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx = (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGroup' AND INDEX_NAME = 'TestCaseGroup_projectId_idx');
SET @sql = IF(@idx <= 0, 'CREATE INDEX `TestCaseGroup_projectId_idx` ON `TestCaseGroup`(`projectId`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 外键（删项目级联删除其用例和分组）
SET @fk = (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'TestCase_projectId_fkey');
SET @sql = IF(@fk <= 0, 'ALTER TABLE `TestCase` ADD CONSTRAINT `TestCase_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk = (SELECT COUNT(1) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'TestCaseGroup_projectId_fkey');
SET @sql = IF(@fk <= 0, 'ALTER TABLE `TestCaseGroup` ADD CONSTRAINT `TestCaseGroup_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TestCaseGroup 唯一约束：name 全局唯一 → (projectId, name) 项目内唯一
SET @old = (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGroup' AND INDEX_NAME = 'TestCaseGroup_name_key');
SET @sql = IF(@old > 0, 'ALTER TABLE `TestCaseGroup` DROP INDEX `TestCaseGroup_name_key`', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @new = (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TestCaseGroup' AND INDEX_NAME = 'TestCaseGroup_projectId_name_key');
SET @sql = IF(@new <= 0, 'CREATE UNIQUE INDEX `TestCaseGroup_projectId_name_key` ON `TestCaseGroup`(`projectId`, `name`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Project.name 唯一
SET @u = (SELECT COUNT(1) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Project' AND INDEX_NAME = 'Project_name_key');
SET @sql = IF(@u <= 0, 'CREATE UNIQUE INDEX `Project_name_key` ON `Project`(`name`)', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
