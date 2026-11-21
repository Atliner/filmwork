-- Back up first; apply to the database used by the application before deploying.
-- Idempotent: preserves existing aggregate counts and history.
CREATE TABLE IF NOT EXISTS content_view_receipts (
  content_id BIGINT UNSIGNED NOT NULL,
  visit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (content_id, visit_id),
  CONSTRAINT fk_view_receipts_content FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
