SET @column_exists = (
  SELECT COUNT(1)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'ProjectVariable'
    AND COLUMN_NAME = 'description'
);

SET @sql = IF(
  @column_exists <= 0,
  'ALTER TABLE `ProjectVariable` ADD COLUMN `description` TEXT NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
