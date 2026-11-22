-- Back up first. Apply after 2026-11-page-ads-bidding.sql, before deploying code.
-- Existing campaigns keep their existing placement, price, history and budget.
SET @has_landing_mode = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ads' AND column_name = 'landing_mode');
SET @sql = IF(@has_landing_mode = 0, 'ALTER TABLE ads ADD COLUMN landing_mode ENUM(''intermediate'',''direct'') NOT NULL DEFAULT ''intermediate'' AFTER telegram_click_mode', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_event_placement = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ad_events' AND column_name = 'placement');
SET @sql = IF(@has_event_placement = 0, 'ALTER TABLE ad_events ADD COLUMN placement VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER event_type', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
CREATE TABLE IF NOT EXISTS ad_campaign_placements (
  ad_id BIGINT UNSIGNED NOT NULL,
  placement VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  unit_price DECIMAL(15,2) NOT NULL,
  bid_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  PRIMARY KEY (ad_id, placement),
  KEY idx_campaign_placements_slot (placement, ad_id),
  CONSTRAINT fk_campaign_placements_ad FOREIGN KEY (ad_id) REFERENCES ads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO ad_campaign_placements (ad_id, placement, unit_price, bid_multiplier)
 SELECT id, placement, unit_price, bid_multiplier FROM ads
 ON DUPLICATE KEY UPDATE ad_id = VALUES(ad_id);
