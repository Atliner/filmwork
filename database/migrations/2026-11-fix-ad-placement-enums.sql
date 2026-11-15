-- Repair existing installations where the post-play name was inconsistent.
-- Back up the database first. Run after 2026-11-ad-settings.sql on existing installs.
-- Widen before touching rows: neither the legacy post_play nor timed_banner is lost.
-- Safe to repeat; existing timed_banner price/configuration wins if both exist.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE ad_placement_prices
  MODIFY COLUMN placement ENUM('pre_roll', 'mid_roll', 'timed_banner', 'post_play', 'pause_overlay',
    'banner_player', 'banner_pause', 'banner_download', 'link_file_button') NOT NULL;
ALTER TABLE ads
  MODIFY COLUMN placement ENUM('pre_roll', 'mid_roll', 'timed_banner', 'post_play', 'pause_overlay',
    'banner_player', 'banner_pause', 'banner_download', 'link_file_button') NOT NULL;

-- If a legacy post_play price exists and the current spelling does not, preserve
-- its actual configured price, active/enabled state and duration.
INSERT INTO ad_placement_prices
  (placement, slot_group, display_name_fa, price_per_thousand, default_duration_seconds,
   minimum_budget, currency, is_active, is_enabled, display_order)
SELECT 'timed_banner', slot_group, display_name_fa, price_per_thousand, default_duration_seconds,
       minimum_budget, currency, is_active, is_enabled, display_order
FROM ad_placement_prices WHERE placement = 'post_play'
ON DUPLICATE KEY UPDATE placement = VALUES(placement);

-- A damaged migration may have neither row; seed only the missing current slot.
INSERT INTO ad_placement_prices
  (placement, slot_group, display_name_fa, price_per_thousand, default_duration_seconds,
   minimum_budget, currency, is_active, is_enabled, display_order)
VALUES ('timed_banner', 'video', 'پس از پخش (Post-roll)', 45000.00, 10, 50000.00, 'IRR', TRUE, TRUE, 3)
ON DUPLICATE KEY UPDATE placement = VALUES(placement);

-- Existing campaigns use the same slot and keep all other data, event history,
-- budgets and review state. Retain the legacy price row for safe rollback.
UPDATE ads SET placement = 'timed_banner' WHERE placement = 'post_play';

-- Session lookups used by the transactional deduplication must not scan a
-- campaign's entire history. Add only when an existing install lacks the index.
SET @has_session_index = (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_events' AND index_name = 'idx_ad_events_session');
SET @index_sql = IF(@has_session_index = 0,
  'ALTER TABLE ad_events ADD INDEX idx_ad_events_session (ad_id, session_key)', 'SELECT 1');
PREPARE session_index_stmt FROM @index_sql;
EXECUTE session_index_stmt;
DEALLOCATE PREPARE session_index_stmt;
