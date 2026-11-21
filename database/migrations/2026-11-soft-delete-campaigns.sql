-- Back up first. Adds soft deletion; financial/event records remain available for audit.
SET @has_deleted_at = (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'ads' AND column_name = 'deleted_at');
SET @sql = IF(@has_deleted_at = 0, 'ALTER TABLE ads ADD COLUMN deleted_at TIMESTAMP(3) NULL AFTER reviewed_at', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
