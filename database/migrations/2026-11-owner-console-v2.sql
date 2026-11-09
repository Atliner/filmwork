-- Filmwork: owner console v2 (overview, content library, draft wizard, versions)
--
-- Safe to run on an existing install: it only adds nullable columns and two new
-- tables. Run it after the original schema.sql, then reload the app.
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- contents: series state, cast/crew, network, hero placement, view counter
-- ---------------------------------------------------------------------------
ALTER TABLE contents
  ADD COLUMN last_air_year SMALLINT UNSIGNED NULL AFTER release_year,
  ADD COLUMN series_running BOOLEAN NOT NULL DEFAULT FALSE AFTER last_air_year,
  ADD COLUMN current_season SMALLINT UNSIGNED NULL AFTER series_running,
  ADD COLUMN broadcast_note VARCHAR(120) NULL AFTER current_season,
  ADD COLUMN episode_count SMALLINT UNSIGNED NULL AFTER broadcast_note,
  ADD COLUMN season_count SMALLINT UNSIGNED NULL AFTER episode_count,
  ADD COLUMN directors JSON NULL AFTER genres,
  ADD COLUMN cast_members JSON NULL AFTER directors,
  ADD COLUMN network VARCHAR(120) NULL AFTER country,
  ADD COLUMN has_dub BOOLEAN NOT NULL DEFAULT FALSE AFTER runtime_minutes,
  ADD COLUMN has_sub BOOLEAN NOT NULL DEFAULT FALSE AFTER has_dub,
  ADD COLUMN poster_gallery JSON NULL AFTER poster_url,
  ADD COLUMN featured_hero BOOLEAN NOT NULL DEFAULT FALSE AFTER status,
  ADD COLUMN view_count BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER featured_hero,
  ADD COLUMN last_viewed_at TIMESTAMP(3) NULL AFTER view_count;

ALTER TABLE contents
  ADD KEY idx_contents_hero (featured_hero, status, created_at),
  ADD CONSTRAINT chk_contents_last_year CHECK (last_air_year IS NULL OR last_air_year BETWEEN 1888 AND 2200),
  ADD CONSTRAINT chk_contents_current_season CHECK (current_season IS NULL OR current_season BETWEEN 1 AND 100);

-- Only one title is promoted into the homepage hero at a time; the console keeps
-- this index in sync by clearing the flag on every other row.
ALTER TABLE contents
  ADD COLUMN hero_slot TINYINT GENERATED ALWAYS AS (IF(featured_hero AND status = 'published', 1, NULL)) STORED,
  ADD UNIQUE KEY uq_contents_hero_slot (hero_slot);

-- ---------------------------------------------------------------------------
-- content_versions: the quality/audio blocks the owner creates under a title
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('sub', 'dub') NOT NULL,
  title VARCHAR(120) NOT NULL,
  resolution VARCHAR(24) NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_content_versions_tree (content_id, kind, sort_order),
  CONSTRAINT fk_content_version_content FOREIGN KEY (content_id) REFERENCES contents(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A version resolves into one or more episode links (movies use a single row with
-- season/episode = NULL). Each row accepts a primary online-play link, a subtitle
-- link and a dubbed-audio link, all of which the bot fills in automatically.
CREATE TABLE IF NOT EXISTS content_version_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id BIGINT UNSIGNED NOT NULL,
  season_number SMALLINT UNSIGNED NULL,
  episode_number SMALLINT UNSIGNED NULL,
  episode_title VARCHAR(255) NULL,
  label VARCHAR(80) NULL,
  size_text VARCHAR(60) NULL,
  stream_url VARCHAR(2048) NULL,
  subtitle_url VARCHAR(2048) NULL,
  dub_url VARCHAR(2048) NULL,
  telegram_url VARCHAR(2048) NULL,
  media_link_id BIGINT UNSIGNED NULL,
  source ENUM('manual', 'telegram_bot') NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_version_links_tree (version_id, season_number, episode_number),
  UNIQUE KEY uq_version_link_media (media_link_id),
  CONSTRAINT fk_version_link_version FOREIGN KEY (version_id) REFERENCES content_versions(id) ON DELETE CASCADE,
  CONSTRAINT fk_version_link_media FOREIGN KEY (media_link_id) REFERENCES media_links(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- admin_events: a compact activity feed for the overview screen
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind ENUM('content', 'media', 'user', 'ad', 'system') NOT NULL DEFAULT 'system',
  title VARCHAR(180) NOT NULL,
  detail VARCHAR(400) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_admin_events_recent (created_at),
  KEY idx_admin_events_kind (kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
