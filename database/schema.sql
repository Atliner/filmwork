-- Filmwork production schema
-- MySQL 8.0+, InnoDB, utf8mb4. Import while connected to the target database.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS contents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  asset_uuid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_type ENUM('movie', 'series') NOT NULL DEFAULT 'movie',
  title VARCHAR(255) NOT NULL,
  original_title VARCHAR(255) NULL,
  slug VARCHAR(280) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  description TEXT NULL,
  imdb_score DECIMAL(3,1) NULL,
  release_year SMALLINT UNSIGNED NULL,
  last_air_year SMALLINT UNSIGNED NULL,
  series_running BOOLEAN NOT NULL DEFAULT FALSE,
  current_season SMALLINT UNSIGNED NULL,
  broadcast_note VARCHAR(120) NULL,
  episode_count SMALLINT UNSIGNED NULL,
  season_count SMALLINT UNSIGNED NULL,
  genres JSON NULL,
  directors JSON NULL,
  cast_members JSON NULL,
  language VARCHAR(80) NULL,
  country VARCHAR(100) NULL,
  network VARCHAR(120) NULL,
  age_rating VARCHAR(20) NULL,
  runtime_minutes SMALLINT UNSIGNED NULL,
  has_dub BOOLEAN NOT NULL DEFAULT FALSE,
  has_sub BOOLEAN NOT NULL DEFAULT FALSE,
  poster_url VARCHAR(2048) NULL,
  poster_gallery JSON NULL,
  backdrop_url VARCHAR(2048) NULL,
  trailer_url VARCHAR(2048) NULL,
  stream_url VARCHAR(2048) NULL,
  status ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'published',
  featured_hero BOOLEAN NOT NULL DEFAULT FALSE,
  hero_slot TINYINT GENERATED ALWAYS AS (IF(featured_hero AND status = 'published', 1, NULL)) STORED,
  view_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMP(3) NULL,
  source_chat_id BIGINT NULL,
  source_message_id BIGINT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contents_asset_uuid (asset_uuid),
  UNIQUE KEY uq_contents_slug (slug),
  KEY idx_contents_listing (status, created_at),
  KEY idx_contents_year (release_year),
  KEY idx_contents_hero (featured_hero, status, created_at),
  UNIQUE KEY uq_contents_hero_slot (hero_slot),
  CONSTRAINT chk_contents_imdb CHECK (imdb_score IS NULL OR (imdb_score >= 0 AND imdb_score <= 10)),
  CONSTRAINT chk_contents_year CHECK (release_year IS NULL OR (release_year BETWEEN 1888 AND 2200))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tg_user_id BIGINT NOT NULL,
  tg_chat_id BIGINT NOT NULL,
  account_name VARCHAR(160) NOT NULL,
  tg_username VARCHAR(64) NULL,
  encrypted_phone TEXT NOT NULL,
  phone_last4 CHAR(4) CHARACTER SET ascii NULL,
  role ENUM('user', 'advertiser') NOT NULL DEFAULT 'user',
  status ENUM('active', 'suspended', 'deleted') NOT NULL DEFAULT 'active',
  last_login_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_tg_user_id (tg_user_id),
  UNIQUE KEY uq_users_tg_chat_id (tg_chat_id),
  KEY idx_users_role_status (role, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  consumed_at TIMESTAMP(3) NULL,
  failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  request_ip VARBINARY(16) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_login_codes_hash (code_hash),
  KEY idx_login_codes_user_active (user_id, consumed_at, expires_at),
  CONSTRAINT fk_login_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS media_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_id BIGINT UNSIGNED NOT NULL,
  parent_id BIGINT UNSIGNED NULL,
  season_number SMALLINT UNSIGNED NULL,
  episode_number SMALLINT UNSIGNED NULL,
  episode_title VARCHAR(255) NULL,
  version_label VARCHAR(120) NOT NULL,
  audio_type ENUM('dubbed', 'hard_sub', 'soft_sub', 'original') NOT NULL DEFAULT 'original',
  subtitle_type ENUM('embedded', 'separate', 'none') NOT NULL DEFAULT 'none',
  resolution VARCHAR(24) NOT NULL,
  quality_label VARCHAR(80) NULL,
  encoder VARCHAR(100) NULL,
  file_size_bytes BIGINT UNSIGNED NOT NULL,
  mime_type VARCHAR(120) NULL,
  stream_url VARCHAR(2048) NULL,

  tg_link_primary VARCHAR(2048) NULL,
  tg_link_fallback_1 VARCHAR(2048) NULL,
  tg_link_fallback_2 VARCHAR(2048) NULL,
  primary_chat_id BIGINT NULL,
  primary_message_id BIGINT NULL,
  fallback_1_chat_id BIGINT NULL,
  fallback_1_message_id BIGINT NULL,
  fallback_2_chat_id BIGINT NULL,
  fallback_2_message_id BIGINT NULL,

  subtitle_link_primary VARCHAR(2048) NULL,
  subtitle_link_fallback_1 VARCHAR(2048) NULL,
  subtitle_link_fallback_2 VARCHAR(2048) NULL,
  subtitle_primary_message_id BIGINT NULL,
  subtitle_fallback_1_message_id BIGINT NULL,
  subtitle_fallback_2_message_id BIGINT NULL,
  subtitle_file_size_bytes BIGINT UNSIGNED NULL,

  health_status ENUM('unchecked', 'healthy', 'promoted', 'unavailable') NOT NULL DEFAULT 'unchecked',
  failure_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMP(3) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ingest_key VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_links_public_id (public_id),
  UNIQUE KEY uq_media_links_ingest_key (ingest_key),
  KEY idx_media_tree (content_id, season_number, episode_number, audio_type, resolution),
  KEY idx_media_parent (parent_id),
  KEY idx_media_health (is_active, health_status),
  CONSTRAINT fk_media_content FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
  CONSTRAINT fk_media_parent FOREIGN KEY (parent_id) REFERENCES media_links(id) ON DELETE SET NULL,
  CONSTRAINT chk_media_file_size CHECK (file_size_bytes > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS media_health_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  media_link_id BIGINT UNSIGNED NOT NULL,
  failed_url VARCHAR(2048) NULL,
  reason VARCHAR(255) NOT NULL,
  promoted_url VARCHAR(2048) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_media_health_events_link (media_link_id, created_at),
  CONSTRAINT fk_media_health_event_link FOREIGN KEY (media_link_id) REFERENCES media_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS comments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  body VARCHAR(1200) NOT NULL,
  status ENUM('visible', 'hidden') NOT NULL DEFAULT 'visible',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_comments_content (content_id, status, created_at),
  KEY idx_comments_user (user_id),
  CONSTRAINT fk_comments_content FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS favorites (
  user_id BIGINT UNSIGNED NOT NULL,
  content_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, content_id),
  KEY idx_favorites_content (content_id),
  CONSTRAINT fk_favorites_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_favorites_content FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS playback_progress (
  user_id BIGINT UNSIGNED NOT NULL,
  content_id BIGINT UNSIGNED NOT NULL,
  position_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  duration_seconds INT UNSIGNED NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT FALSE,
  last_watched_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, content_id),
  KEY idx_progress_recent (user_id, completed, last_watched_at),
  CONSTRAINT fk_progress_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_progress_content FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE,
  CONSTRAINT chk_progress_position CHECK (position_seconds <= duration_seconds OR duration_seconds = 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS download_history (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  media_link_id BIGINT UNSIGNED NOT NULL,
  delivery_method ENUM('telegram_copy', 'telegram_link') NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_download_history_user (user_id, created_at),
  KEY idx_download_history_media (media_link_id),
  CONSTRAINT fk_download_history_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_download_history_media FOREIGN KEY (media_link_id) REFERENCES media_links(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS advertiser_wallets (
  user_id BIGINT UNSIGNED NOT NULL,
  balance DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'IRR',
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id),
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_wallet_balance CHECK (balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_placement_prices (
  placement ENUM('pre_roll', 'mid_roll', 'post_play', 'pause_overlay',
                 'banner_player', 'banner_pause', 'banner_download', 'link_file_button') NOT NULL,
  slot_group ENUM('video', 'banner', 'link') NOT NULL DEFAULT 'video',
  display_name_fa VARCHAR(80) NOT NULL,
  price_per_thousand DECIMAL(15,2) NOT NULL,
  default_duration_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 15,
  minimum_budget DECIMAL(15,2) NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'IRR',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  display_order TINYINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (placement),
  CONSTRAINT chk_ad_price CHECK (price_per_thousand > 0 AND minimum_budget > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ad_placement_prices
  (placement, slot_group, display_name_fa, price_per_thousand, default_duration_seconds,
   minimum_budget, currency, is_enabled, display_order)
VALUES
  ('pre_roll', 'video', 'پیش از پخش (Pre-roll)', 50000.00, 15, 50000.00, 'IRR', TRUE, 1),
  ('mid_roll', 'video', 'میان‌پخش (Mid-roll)', 45000.00, 15, 50000.00, 'IRR', TRUE, 2),
  ('timed_banner', 'video', 'پس از پخش (Post-roll)', 45000.00, 10, 50000.00, 'IRR', TRUE, 3),
  ('pause_overlay', 'video', 'لایه هنگام توقف (Pause)', 32000.00, 15, 50000.00, 'IRR', TRUE, 4),
  ('banner_player', 'banner', 'بنر روی پلیر (۷۲۸×۹۰)', 50000.00, 8, 50000.00, 'IRR', TRUE, 5),
  ('banner_pause', 'banner', 'بنر توقف (۳۰۰×۲۵۰)', 40000.00, 8, 50000.00, 'IRR', TRUE, 6),
  ('banner_download', 'banner', 'بنر قبل از دانلود (۱۰۸۰×۱۹۲۰)', 60000.00, 8, 50000.00, 'IRR', TRUE, 7),
  ('link_file_button', 'link', 'دکمه لینک زیر فایل (ربات)', 50000.00, 0, 50000.00, 'IRR', TRUE, 8)
ON DUPLICATE KEY UPDATE
  slot_group = VALUES(slot_group),
  display_name_fa = VALUES(display_name_fa),
  default_duration_seconds = VALUES(default_duration_seconds),
  display_order = VALUES(display_order);

CREATE TABLE IF NOT EXISTS ads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  advertiser_id BIGINT UNSIGNED NOT NULL,
  campaign_name VARCHAR(180) NOT NULL,
  headline VARCHAR(180) NOT NULL,
  body VARCHAR(1000) NULL,
  placement ENUM('pre_roll', 'timed_banner', 'pause_overlay') NOT NULL,
  asset_type ENUM('video', 'image') NOT NULL,
  creative_url VARCHAR(2048) NOT NULL,
  target_url VARCHAR(2048) NULL,
  telegram_post_text TEXT NULL,
  telegram_buttons JSON NULL,
  targeting JSON NULL,
  pricing_model ENUM('cpm') NOT NULL DEFAULT 'cpm',
  unit_price DECIMAL(15,2) NOT NULL,
  budget DECIMAL(15,2) NOT NULL,
  spent DECIMAL(15,2) NOT NULL DEFAULT 0.00,
  status ENUM('pending', 'active', 'paused', 'completed', 'rejected') NOT NULL DEFAULT 'pending',
  skip_after_seconds TINYINT UNSIGNED NOT NULL DEFAULT 5,
  duration_seconds SMALLINT UNSIGNED NULL,
  owner_campaign BOOLEAN NOT NULL DEFAULT FALSE,
  creative_local_path VARCHAR(255) NULL,
  review_note VARCHAR(255) NULL,
  reviewed_at TIMESTAMP(3) NULL,
  starts_at TIMESTAMP(3) NOT NULL,
  ends_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ads_public_id (public_id),
  KEY idx_ads_serving (placement, status, starts_at, ends_at),
  KEY idx_ads_advertiser (advertiser_id, created_at),
  CONSTRAINT fk_ads_advertiser FOREIGN KEY (advertiser_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT chk_ads_budget CHECK (budget > 0 AND spent >= 0 AND spent <= budget),
  CONSTRAINT chk_ads_dates CHECK (ends_at > starts_at),
  CONSTRAINT chk_ads_skip CHECK (skip_after_seconds BETWEEN 0 AND 30)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  ad_id BIGINT UNSIGNED NULL,
  transaction_type ENUM('credit', 'campaign_reserve', 'refund', 'adjustment') NOT NULL,
  amount DECIMAL(15,2) NOT NULL,
  balance_after DECIMAL(15,2) NOT NULL,
  reference VARCHAR(190) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_wallet_reference (reference),
  KEY idx_wallet_transactions_user (user_id, created_at),
  CONSTRAINT fk_wallet_tx_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wallet_tx_ad FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE SET NULL,
  CONSTRAINT chk_wallet_tx_amount CHECK (amount > 0),
  CONSTRAINT chk_wallet_tx_balance CHECK (balance_after >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  setting_value TEXT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ad_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ad_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NULL,
  event_type ENUM('impression', 'click', 'skip', 'complete') NOT NULL,
  session_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  user_agent VARCHAR(500) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_ad_event_dedupe (ad_id, event_type, session_key),
  KEY idx_ad_events_reporting (ad_id, event_type, created_at),
  CONSTRAINT fk_ad_events_ad FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE,
  CONSTRAINT fk_ad_events_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bot_ingest_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_tg_user_id BIGINT NOT NULL,
  source_chat_id BIGINT NOT NULL,
  content_id BIGINT UNSIGNED NOT NULL,
  directives JSON NOT NULL,
  status ENUM('waiting_media', 'processing', 'complete', 'expired') NOT NULL DEFAULT 'waiting_media',
  expires_at TIMESTAMP(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ingest_session_lookup (source_chat_id, status, expires_at),
  CONSTRAINT fk_ingest_session_content FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bot_media_bundles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  bundle_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  video_payload JSON NOT NULL,
  subtitle_payload JSON NULL,
  finalize_after TIMESTAMP(3) NOT NULL,
  status ENUM('waiting_subtitle', 'finalizing', 'complete', 'failed') NOT NULL DEFAULT 'waiting_subtitle',
  last_error VARCHAR(500) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bot_bundle_key (bundle_key),
  KEY idx_bot_bundles_pending (status, finalize_after),
  CONSTRAINT fk_bot_bundle_session FOREIGN KEY (session_id) REFERENCES bot_ingest_sessions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_login_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_tg_user_id BIGINT NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at TIMESTAMP(3) NOT NULL,
  consumed_at TIMESTAMP(3) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_token_hash (token_hash),
  KEY idx_admin_tokens_owner (owner_tg_user_id, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS content_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('sub', 'dub') NOT NULL,
  title VARCHAR(120) NOT NULL,
  resolution VARCHAR(24) NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_content_versions_tree (content_id, kind, sort_order),
  CONSTRAINT fk_content_version_content FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS content_version_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id BIGINT UNSIGNED NOT NULL,
  season_number SMALLINT UNSIGNED NULL,
  episode_number SMALLINT UNSIGNED NULL,
  episode_title VARCHAR(255) NULL,
  label VARCHAR(80) NULL,
  size_text VARCHAR(60) NULL,
  stream_url VARCHAR(2048) NULL,
  subtitle_url VARCHAR(2048) NULL,
  dub_url VARCHAR(2048) NULL,
  telegram_url VARCHAR(2048) NULL,
  media_link_id BIGINT UNSIGNED NULL,
  source ENUM('manual', 'telegram_bot') NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_version_links_tree (version_id, season_number, episode_number),
  UNIQUE KEY uq_version_link_media (media_link_id),
  CONSTRAINT fk_version_link_version FOREIGN KEY (version_id) REFERENCES content_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_version_link_media FOREIGN KEY (media_link_id) REFERENCES media_links(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind ENUM('content', 'media', 'user', 'ad', 'system') NOT NULL DEFAULT 'system',
  title VARCHAR(180) NOT NULL,
  detail VARCHAR(400) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_admin_events_recent (created_at),
  KEY idx_admin_events_kind (kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The API performs this same shift inside a row-locked transaction and does not
-- depend on this procedure. It is also exposed here for maintenance/recovery.
DROP PROCEDURE IF EXISTS promote_media_fallback;
DELIMITER $$
CREATE PROCEDURE promote_media_fallback(IN p_media_id BIGINT UNSIGNED, IN p_reason VARCHAR(255))
BEGIN
  DECLARE v_failed VARCHAR(2048);
  DECLARE v_promoted VARCHAR(2048);
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  START TRANSACTION;
  SELECT tg_link_primary, tg_link_fallback_1
    INTO v_failed, v_promoted
    FROM media_links
    WHERE id = p_media_id
    FOR UPDATE;

  UPDATE media_links
  SET
    tg_link_primary = tg_link_fallback_1,
    tg_link_fallback_1 = tg_link_fallback_2,
    tg_link_fallback_2 = NULL,
    primary_chat_id = fallback_1_chat_id,
    primary_message_id = fallback_1_message_id,
    fallback_1_chat_id = fallback_2_chat_id,
    fallback_1_message_id = fallback_2_message_id,
    fallback_2_chat_id = NULL,
    fallback_2_message_id = NULL,
    subtitle_link_primary = subtitle_link_fallback_1,
    subtitle_link_fallback_1 = subtitle_link_fallback_2,
    subtitle_link_fallback_2 = NULL,
    subtitle_primary_message_id = subtitle_fallback_1_message_id,
    subtitle_fallback_1_message_id = subtitle_fallback_2_message_id,
    subtitle_fallback_2_message_id = NULL,
    health_status = IF(v_promoted IS NULL, 'unavailable', 'promoted'),
    failure_count = failure_count + 1,
    last_checked_at = CURRENT_TIMESTAMP(3),
    is_active = (v_promoted IS NOT NULL)
  WHERE id = p_media_id;

  INSERT INTO media_health_events (media_link_id, failed_url, reason, promoted_url)
  VALUES (p_media_id, v_failed, LEFT(p_reason, 255), v_promoted);
  COMMIT;
END$$
DELIMITER ;
