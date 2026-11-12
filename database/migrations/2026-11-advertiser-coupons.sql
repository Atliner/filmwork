-- Advertiser wallet coupons. Run after the existing Filmwork schema/migrations.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET time_zone = '+00:00';

ALTER TABLE wallet_transactions
  MODIFY COLUMN transaction_type ENUM('credit', 'campaign_reserve', 'refund', 'adjustment', 'coupon_credit') NOT NULL;

CREATE TABLE IF NOT EXISTS advertiser_coupons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  credit_amount DECIMAL(15,2) NOT NULL,
  usage_limit INT UNSIGNED NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_advertiser_coupon_code (code),
  CONSTRAINT chk_coupon_credit CHECK (credit_amount > 0),
  CONSTRAINT chk_coupon_usage_limit CHECK (usage_limit IS NULL OR usage_limit > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS advertiser_coupon_redemptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coupon_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  credit_amount DECIMAL(15,2) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_coupon_redemption_user (coupon_id, user_id),
  KEY idx_coupon_redemptions_user (user_id, created_at),
  CONSTRAINT fk_coupon_redemption_coupon FOREIGN KEY (coupon_id) REFERENCES advertiser_coupons(id) ON DELETE CASCADE,
  CONSTRAINT fk_coupon_redemption_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_coupon_redemption_credit CHECK (credit_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
