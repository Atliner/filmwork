-- Back up the database and stop application workers first. Run before code deployment.
-- Telegram download subtitles and playback tracks are distinct and never copied
-- from the old projection automatically, where their meaning may be ambiguous.
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='media_links' AND column_name='playback_subtitle_url');
SET @sql = IF(@has_col=0, 'ALTER TABLE media_links ADD COLUMN playback_subtitle_url TEXT NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='media_links' AND column_name='playback_audio_url');
SET @sql = IF(@has_col=0, 'ALTER TABLE media_links ADD COLUMN playback_audio_url TEXT NULL', 'SELECT 1'); PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
