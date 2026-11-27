-- Optional: requires CREATE ROUTINE / ALTER ROUTINE. API does not call this procedure.
-- Keep the optional database procedure consistent with the application.
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
    tg_link_fallback_2 = tg_link_fallback_3,
    tg_link_fallback_3 = NULL,
    primary_chat_id = fallback_1_chat_id,
    primary_message_id = fallback_1_message_id,
    fallback_1_chat_id = fallback_2_chat_id,
    fallback_1_message_id = fallback_2_message_id,
    fallback_2_chat_id = fallback_3_chat_id,
    fallback_2_message_id = fallback_3_message_id,
    fallback_3_chat_id = NULL,
    fallback_3_message_id = NULL,
    subtitle_link_primary = subtitle_link_fallback_1,
    subtitle_link_fallback_1 = subtitle_link_fallback_2,
    subtitle_link_fallback_2 = subtitle_link_fallback_3,
    subtitle_link_fallback_3 = NULL,
    subtitle_primary_message_id = subtitle_fallback_1_message_id,
    subtitle_fallback_1_message_id = subtitle_fallback_2_message_id,
    subtitle_fallback_2_message_id = subtitle_fallback_3_message_id,
    subtitle_fallback_3_message_id = NULL,
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
