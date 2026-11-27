-- Persistent deletion jobs for messages sent to users, never channel copies.
CREATE TABLE IF NOT EXISTS telegram_deletion_queue (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  chat_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  delete_after DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_until DATETIME(3) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  failed BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (id),
  UNIQUE KEY uq_telegram_deletion_message (chat_id, message_id),
  KEY idx_telegram_deletion_due (delete_after, lease_until),
  KEY idx_telegram_deletion_lease (lease_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
