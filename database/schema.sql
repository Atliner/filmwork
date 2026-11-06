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
  genres JSON NULL,
  language VARCHAR(80) NULL,
  country VARCHAR(100) NULL,
  age_rating VARCHAR(20) NULL,
  runtime_minutes SMALLINT UNSIGNED NULL,
  poster_url VARCHAR(2048) NULL,
  backdrop_url VARCHAR(2048) NULL,
  trailer_url VARCHAR(2048) NULL,
  stream_url VARCHAR(2048) NULL,
  status ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'published',
  source_chat_id BIGINT NULL,
  source_message_id BIGINT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_contents_asset_uuid (asset_uuid),
  UNIQUE KEY uq_contents_slug (slug),
  KEY idx_contents_listing (status, created_at),
  KEY idx_contents_year (release_year),
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
  placement ENUM('pre_roll', 'timed_banner', 'pause_overlay') NOT NULL,
  display_name_fa VARCHAR(80) NOT NULL,
  price_per_thousand DECIMAL(15,2) NOT NULL,
  minimum_budget DECIMAL(15,2) NOT NULL,
  currency CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'IRR',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (placement),
  CONSTRAINT chk_ad_price CHECK (price_per_thousand > 0 AND minimum_budget > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ad_placement_prices (placement, display_name_fa, price_per_thousand, minimum_budget, currency)
VALUES
  ('pre_roll', 'پیش‌نمایش ویدیویی', 4500000.00, 9000000.00, 'IRR'),
  ('timed_banner', 'بنر زمان‌بندی‌شده زیر پلیر', 2800000.00, 5600000.00, 'IRR'),
  ('pause_overlay', 'لایه هنگام توقف', 3200000.00, 6400000.00, 'IRR')
ON DUPLICATE KEY UPDATE
  display_name_fa = VALUES(display_name_fa),
  price_per_thousand = VALUES(price_per_thousand),
  minimum_budget = VALUES(minimum_budget),
  currency = VALUES(currency);

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
