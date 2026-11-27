-- Back up the database. Apply after the previous ad-settings and placement migrations.
-- New placements start disabled; the owner can set their prices and enable them.
ALTER TABLE ad_placement_prices MODIFY COLUMN placement ENUM('pre_roll','mid_roll','timed_banner','post_play','pause_overlay','banner_player','banner_pause','banner_download','link_file_button','banner_home','text_home','banner_detail','text_detail','banner_search','text_search') NOT NULL;
ALTER TABLE ads MODIFY COLUMN placement ENUM('pre_roll','mid_roll','timed_banner','post_play','pause_overlay','banner_player','banner_pause','banner_download','link_file_button','banner_home','text_home','banner_detail','text_detail','banner_search','text_search') NOT NULL;
-- CPM is charged in thousandths of a 2-decimal unit price. Preserve all five
-- decimal places in reserved balances and refunds, not rounded per impression.
ALTER TABLE ads MODIFY COLUMN budget DECIMAL(20,5) NOT NULL, MODIFY COLUMN spent DECIMAL(20,5) NOT NULL DEFAULT 0.00000;
ALTER TABLE advertiser_wallets MODIFY COLUMN balance DECIMAL(20,5) NOT NULL DEFAULT 0.00000;
ALTER TABLE wallet_transactions MODIFY COLUMN amount DECIMAL(20,5) NOT NULL, MODIFY COLUMN balance_after DECIMAL(20,5) NOT NULL;
SET @has_bid = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ads' AND column_name = 'bid_multiplier');
SET @sql = IF(@has_bid = 0, 'ALTER TABLE ads ADD COLUMN bid_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1.00 AFTER unit_price', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @has_click_mode = (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'ads' AND column_name = 'telegram_click_mode');
SET @sql = IF(@has_click_mode = 0, 'ALTER TABLE ads ADD COLUMN telegram_click_mode ENUM(''tracked'',''direct'') NOT NULL DEFAULT ''tracked'' AFTER target_url', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
INSERT INTO ad_placement_prices (placement,slot_group,display_name_fa,price_per_thousand,default_duration_seconds,minimum_budget,currency,is_active,is_enabled,display_order) VALUES
('banner_home','banner','بنر صفحهٔ اصلی',50000,0,50000,'IRR',FALSE,FALSE,9),
('text_home','banner','تبلیغ متنی صفحهٔ اصلی',50000,0,50000,'IRR',FALSE,FALSE,10),
('banner_detail','banner','بنر صفحهٔ جزئیات اثر',50000,0,50000,'IRR',FALSE,FALSE,11),
('text_detail','banner','تبلیغ متنی صفحهٔ جزئیات اثر',50000,0,50000,'IRR',FALSE,FALSE,12),
('banner_search','banner','بنر صفحهٔ جست‌وجو',50000,0,50000,'IRR',FALSE,FALSE,13),
('text_search','banner','تبلیغ متنی صفحهٔ جست‌وجو',50000,0,50000,'IRR',FALSE,FALSE,14)
ON DUPLICATE KEY UPDATE placement = VALUES(placement);
