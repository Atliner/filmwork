-- Back up the database first. Run before deploying the four-replica code.
-- Safe to run again after a partially completed upgrade.
-- Eight utf8mb4 VARCHAR(2048) URLs exceed MySQL's row-size limit. TEXT keeps
-- the existing values while storing long URLs off-row; none of these columns are indexed.
SET @needs_text = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='media_links' AND column_name IN ('tg_link_primary','tg_link_fallback_1','tg_link_fallback_2','subtitle_link_primary','subtitle_link_fallback_1','subtitle_link_fallback_2') AND data_type <> 'text');
SET @sql = IF(@needs_text > 0, 'ALTER TABLE media_links MODIFY COLUMN tg_link_primary TEXT NULL, MODIFY COLUMN tg_link_fallback_1 TEXT NULL, MODIFY COLUMN tg_link_fallback_2 TEXT NULL, MODIFY COLUMN subtitle_link_primary TEXT NULL, MODIFY COLUMN subtitle_link_fallback_1 TEXT NULL, MODIFY COLUMN subtitle_link_fallback_2 TEXT NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'media_links' AND column_name = 'tg_link_fallback_3');
SET @sql = IF(@has_col = 0, 'ALTER TABLE media_links ADD COLUMN tg_link_fallback_3 TEXT NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'media_links' AND column_name = 'fallback_3_chat_id');
SET @sql = IF(@has_col = 0, 'ALTER TABLE media_links ADD COLUMN fallback_3_chat_id BIGINT NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'media_links' AND column_name = 'fallback_3_message_id');
SET @sql = IF(@has_col = 0, 'ALTER TABLE media_links ADD COLUMN fallback_3_message_id BIGINT NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'media_links' AND column_name = 'subtitle_link_fallback_3');
SET @sql = IF(@has_col = 0, 'ALTER TABLE media_links ADD COLUMN subtitle_link_fallback_3 TEXT NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'media_links' AND column_name = 'subtitle_fallback_3_message_id');
SET @sql = IF(@has_col = 0, 'ALTER TABLE media_links ADD COLUMN subtitle_fallback_3_message_id BIGINT NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
