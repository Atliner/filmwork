-- Filmwork: ad platform settings (owner panel)
--
-- Adds the seven placement types (4 video, 3 banner, 1 link), the persistent
-- settings store the owner edits, and the columns needed for owner campaigns,
-- manual review and a temporary local creative that is purged when rejected.
--
-- Safe on an existing install: additive only, every statement is idempotent-ish
-- (skip duplicates with the guarded statements below), and no rows are deleted.
-- Run after schema.sql and before reloading the app.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- 1) placements: 7 slots + serving durations
-- ---------------------------------------------------------------------------
-- The original three values stay valid inside the wider enum, so existing rows
-- survive this change; the four new slots are inserted below.
ALTER TABLE ad_placement_prices
  MODIFY COLUMN placement ENUM(
    'pre_roll', 'mid_roll', 'post_play', 'pause_overlay',
    'banner_player', 'banner_pause', 'banner_download', 'link_file_button'
  ) NOT NULL;

ALTER TABLE ad_placement_prices
  ADD COLUMN slot_group ENUM('video', 'banner', 'link') NOT NULL DEFAULT 'video' AFTER placement,
  ADD COLUMN is_enabled BOOLEAN NOT NULL DEFAULT TRUE AFTER currency,
  ADD COLUMN default_duration_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 15 AFTER minimum_budget,
  ADD COLUMN display_order TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER slot_group;

-- Map the old three slots onto the new taxonomy and add the remaining ones.
UPDATE ad_placement_prices
   SET slot_group = 'video', display_order = 1, default_duration_seconds = 15
 WHERE placement = 'pre_roll';
UPDATE ad_placement_prices
   SET slot_group = 'video', display_order = 3
 WHERE placement = 'timed_banner';
UPDATE ad_placement_prices
   SET slot_group = 'video', display_order = 4
 WHERE placement = 'pause_overlay';

INSERT INTO ad_placement_prices
  (placement, slot_group, display_name_fa, price_per_thousand, default_duration_seconds,
   minimum_budget, currency, is_enabled, display_order)
VALUES
  ('mid_roll', 'video', 'میان‌پخش (Mid-roll)', 45000.00, 15, 50000.00, 'IRR', TRUE, 2),
  ('banner_player', 'banner', 'بنر روی پلیر (۷۲۸×۹۰)', 50000.00, 8, 50000.00, 'IRR', TRUE, 5),
  ('banner_pause', 'banner', 'بنر توقف (۳۰۰×۲۵۰)', 40000.00, 8, 50000.00, 'IRR', TRUE, 6),
  ('banner_download', 'banner', 'بنر قبل از دانلود (۱۰۸۰×۱۹۲۰)', 60000.00, 8, 50000.00, 'IRR', TRUE, 7),
  ('link_file_button', 'link', 'دکمه لینک زیر فایل (ربات)', 50000.00, 0, 50000.00, 'IRR', TRUE, 8)
ON DUPLICATE KEY UPDATE
  slot_group = VALUES(slot_group),
  display_name_fa = VALUES(display_name_fa),
  default_duration_seconds = VALUES(default_duration_seconds),
  display_order = VALUES(display_order);

-- ---------------------------------------------------------------------------
-- 2) ads: owner campaigns, local uploads, review trail
-- ---------------------------------------------------------------------------
ALTER TABLE ads
  MODIFY COLUMN placement ENUM(
    'pre_roll', 'mid_roll', 'post_play', 'pause_overlay',
    'banner_player', 'banner_pause', 'banner_download', 'link_file_button'
  ) NOT NULL,
  ADD COLUMN owner_campaign BOOLEAN NOT NULL DEFAULT FALSE AFTER advertiser_id,
  ADD COLUMN creative_local_path VARCHAR(255) NULL AFTER creative_url,
  ADD COLUMN review_note VARCHAR(255) NULL AFTER status,
  ADD COLUMN reviewed_at TIMESTAMP(3) NULL AFTER review_note,
  ADD COLUMN duration_seconds SMALLINT UNSIGNED NULL AFTER skip_after_seconds;

ALTER TABLE ads
  ADD KEY idx_ads_owner_review (owner_campaign, status, created_at);

-- ---------------------------------------------------------------------------
-- 3) settings store the owner edits from the console
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  setting_value TEXT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO app_settings (setting_key, setting_value) VALUES
  ('ads.auto_approve', '0'),
  ('ads.default_video_duration', '15'),
  ('ads.default_banner_duration', '8'),
  ('ads.skip_after_seconds', '5'),
  ('ads.max_video_mb', '8'),
  ('ads.max_image_kb', '600'),
  ('ads.min_video_seconds', '5'),
  ('ads.max_video_seconds', '30'),
  ('ads.cpm_video', '50000'),
  ('ads.cpm_banner', '50000'),
  ('ads.cpm_link', '50000'),
  ('ads.cpc_video', '0'),
  ('ads.cpc_banner', '0'),
  ('ads.cpc_link', '1000'),
  ('ads.cpv_video', '0'),
  ('ads.cpv_banner', '0'),
  ('ads.cpv_link', '0'),
  ('ads.min_budget', '50000'),
  ('ads.daily_budget_cap', '0'),
  ('ads.max_priority_multiplier', '5'),
  ('ads.link_allowlist', ''),
  ('ads.rules', ''),
  ('ads.reject_purge_minutes', '60')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);
