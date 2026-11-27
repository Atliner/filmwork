-- Stop application workers and back up before this migration. Apply before code deployment.
-- Existing manual links get stable, opaque public IDs; no links or history are removed.
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='content_version_links' AND column_name='public_id');
SET @sql = IF(@has_col=0, 'ALTER TABLE content_version_links ADD COLUMN public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
UPDATE content_version_links SET public_id = UUID() WHERE public_id IS NULL;
SET @has_idx = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='content_version_links' AND index_name='uq_content_version_link_public');
SET @sql = IF(@has_idx=0, 'ALTER TABLE content_version_links ADD UNIQUE KEY uq_content_version_link_public (public_id)', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='download_history' AND column_name='manual_version_link_id');
SET @sql = IF(@has_col=0, 'ALTER TABLE download_history ADD COLUMN manual_version_link_id BIGINT UNSIGNED NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
ALTER TABLE download_history MODIFY COLUMN media_link_id BIGINT UNSIGNED NULL;
SET @has_idx = (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='download_history' AND index_name='idx_download_history_manual');
SET @sql = IF(@has_idx=0, 'ALTER TABLE download_history ADD KEY idx_download_history_manual (manual_version_link_id)', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_fk = (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema=DATABASE() AND table_name='download_history' AND constraint_name='fk_download_history_manual');
SET @sql = IF(@has_fk=0, 'ALTER TABLE download_history ADD CONSTRAINT fk_download_history_manual FOREIGN KEY (manual_version_link_id) REFERENCES content_version_links(id) ON DELETE CASCADE', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
