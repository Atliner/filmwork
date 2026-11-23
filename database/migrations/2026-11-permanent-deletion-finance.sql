-- Back up first; stop the application. Apply after 2026-11-ad-multiple-placements.sql.
-- Additive, repeatable. No old campaigns, financial records or logs are deleted here.
SET @exists_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='wallet_transactions' AND column_name='campaign_public_id');
SET @sql = IF(@exists_col=0, 'ALTER TABLE wallet_transactions ADD COLUMN campaign_public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER ad_id', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @exists_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='admin_events' AND column_name='content_asset_id');
SET @sql = IF(@exists_col=0, 'ALTER TABLE admin_events ADD COLUMN content_asset_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @exists_col = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='admin_events' AND column_name='ad_public_id');
SET @sql = IF(@exists_col=0, 'ALTER TABLE admin_events ADD COLUMN ad_public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
CREATE TABLE IF NOT EXISTS ad_financial_archive (
  campaign_public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  advertiser_id BIGINT UNSIGNED NOT NULL,
  owner_campaign BOOLEAN NOT NULL,
  primary_placement VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  budget DECIMAL(20,5) NOT NULL,
  spent DECIMAL(20,5) NOT NULL,
  status_at_deletion VARCHAR(24) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL,
  deleted_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (campaign_public_id),
  KEY idx_ad_financial_advertiser (advertiser_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS ad_financial_placement_rates (
  campaign_public_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  placement VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  unit_price DECIMAL(15,2) NOT NULL,
  bid_multiplier DECIMAL(5,2) NOT NULL,
  PRIMARY KEY (campaign_public_id, placement),
  CONSTRAINT fk_financial_rates_archive FOREIGN KEY (campaign_public_id) REFERENCES ad_financial_archive(campaign_public_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
