-- Back up and stop the application first; apply after 2026-11-ad-multiple-placements.sql.
-- Never convert an existing video campaign into an image or change its price.
ALTER TABLE ad_placement_prices MODIFY COLUMN placement ENUM('pre_roll','mid_roll','timed_banner','post_play','pause_overlay','banner_player','banner_pause','banner_download','video_download','link_file_button','banner_home','text_home','banner_detail','text_detail','banner_search','text_search') NOT NULL;
ALTER TABLE ads MODIFY COLUMN placement ENUM('pre_roll','mid_roll','timed_banner','post_play','pause_overlay','banner_player','banner_pause','banner_download','video_download','link_file_button','banner_home','text_home','banner_detail','text_detail','banner_search','text_search') NOT NULL;
INSERT INTO ad_placement_prices (placement,slot_group,display_name_fa,price_per_thousand,default_duration_seconds,minimum_budget,currency,is_enabled,is_active,display_order)
VALUES ('video_download','video','ویدیو قبل از دانلود',50000,15,50000,'IRR',FALSE,TRUE,4)
ON DUPLICATE KEY UPDATE placement=VALUES(placement);
UPDATE ad_placement_prices SET is_enabled=FALSE,is_active=FALSE WHERE placement='pause_overlay';
-- Active campaigns that have no other placement stop accruing charges; their
-- unspent reservation remains available for normal deletion/refund/settlement.
UPDATE ads a SET a.status='paused'
WHERE a.status='active' AND EXISTS (SELECT 1 FROM ad_campaign_placements p WHERE p.ad_id=a.id AND p.placement='pause_overlay')
  AND NOT EXISTS (SELECT 1 FROM ad_campaign_placements p WHERE p.ad_id=a.id AND p.placement<>'pause_overlay');
