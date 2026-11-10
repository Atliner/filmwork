'use strict';

const crypto = require('crypto');
const { query, withTransaction } = require('../config/db');
const { AppError, assert } = require('../lib/errors');
const { composeOverview } = require('./adminOverview');

function jsonColumn(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function slugify(title, uuid) {
  const base = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 220);
  return `${base || 'title'}-${uuid.slice(0, 8)}`;
}

function escapeLike(value) {
  return String(value || '').replace(/[!%_]/g, '!$&');
}

const CONTENT_COLUMNS = `
  c.id, c.asset_uuid, c.content_type, c.title, c.original_title, c.slug, c.description,
  c.imdb_score, c.release_year, c.last_air_year, c.series_running, c.current_season,
  c.broadcast_note, c.episode_count, c.season_count, c.genres, c.directors, c.cast_members,
  c.country, c.network, c.age_rating, c.runtime_minutes, c.has_dub, c.has_sub,
  c.poster_url, c.poster_gallery, c.backdrop_url, c.trailer_url, c.stream_url,
  c.status, c.featured_hero, c.view_count, c.created_at, c.updated_at`;

function listRow(row) {
  return {
    id: row.asset_uuid,
    internalId: String(row.id),
    type: row.content_type,
    title: row.title,
    originalTitle: row.original_title,
    posterUrl: row.poster_url,
    releaseYear: row.release_year,
    lastAirYear: row.last_air_year,
    imdbScore: row.imdb_score === null ? null : Number(row.imdb_score),
    status: row.status,
    featuredHero: Boolean(row.featured_hero),
    views: Number(row.view_count || 0),
    seasons: row.season_count === null ? null : Number(row.season_count),
    episodes: row.episode_count === null ? null : Number(row.episode_count),
    seriesRunning: Boolean(row.series_running),
    currentSeason: row.current_season === null ? null : Number(row.current_season),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    qualities: (jsonColumn(row.qualities) || []).filter(Boolean),
    directors: row.directors === undefined ? undefined : (jsonColumn(row.directors) || []),
    cast: row.cast_members === undefined ? undefined : (jsonColumn(row.cast_members) || []),
    hasDub: Boolean(row.has_dub),
    hasSub: Boolean(row.has_sub),
    mediaCount: row.media_count === undefined ? undefined : Number(row.media_count),
    genres: row.genres === undefined ? undefined : (jsonColumn(row.genres) || []),
    countries: row.country ? String(row.country).split(/[,،]\s*/).filter(Boolean) : [],
    network: row.network || null,
    ageRating: row.age_rating || null,
    runtimeMinutes: row.runtime_minutes || null,
    description: row.description || null,
  };
}

function detailRow(row) {
  return {
    ...listRow(row),
    description: row.description,
    genres: jsonColumn(row.genres) || [],
    directors: jsonColumn(row.directors) || [],
    cast: jsonColumn(row.cast_members) || [],
    countries: row.country ? String(row.country).split(/[,،]\s*/).filter(Boolean) : [],
    network: row.network,
    ageRating: row.age_rating,
    runtimeMinutes: row.runtime_minutes,
    broadcastNote: row.broadcast_note,
    posterGallery: jsonColumn(row.poster_gallery) || [],
    backdropUrl: row.backdrop_url,
    trailerUrl: row.trailer_url,
    streamUrl: row.stream_url,
  };
}

function versionDto(version, links) {
  return {
    id: String(version.id),
    kind: version.kind,
    title: version.title,
    resolution: version.resolution,
    sortOrder: Number(version.sort_order),
    links: links.map((link) => ({
      id: String(link.id),
      season: link.season_number,
      episode: link.episode_number,
      title: link.episode_title,
      label: link.label,
      sizeText: link.size_text,
      streamUrl: link.stream_url,
      subtitleUrl: link.subtitle_url,
      dubUrl: link.dub_url,
      telegramUrl: link.telegram_url,
      source: link.source,
    })),
  };
}

async function logEvent(kind, title, detail, connection = null) {
  const sql = 'INSERT INTO admin_events (kind, title, detail) VALUES (:kind, :title, :detail)';
  const params = { kind, title: String(title).slice(0, 180), detail: detail ? String(detail).slice(0, 400) : null };
  try {
    if (connection) await connection.execute(sql, params);
    else await query(sql, params);
  } catch (error) {
    // The feed is cosmetic: never fail a successful write because of it.
    console.warn('admin_events insert failed', error.message);
  }
}

/**
 * Index `uq_contents_hero_slot` guarantees a single published hero, so the previous
 * title must be demoted **before** the new row is written — not after.
 */
async function clearHeroSlot(connection) {
  await connection.execute('UPDATE contents SET featured_hero = FALSE WHERE featured_hero = TRUE');
}

const store = {
  kind: 'mysql',

  async overview() {
    const count = async (sql, params = {}) => (await query(sql, params))[0] || {};
    // A single unsupported statement used to blank the whole dashboard. Shared
    // hosting often runs MariaDB, which lacks MySQL-8-only features (JSON_TABLE),
    // so every block degrades to an empty value instead of a 500.
    const safe = async (label, run, fallback) => {
      try {
        return await run();
      } catch (error) {
        overviewWarnings.push({ block: label, message: error.sqlMessage || error.message });
        return fallback;
      }
    };
    const overviewWarnings = [];
    const [contents, media, resolutions, users, ads, views, timeline, genres, topContents, weekly, activity, health] = await Promise.all([
      safe('contents', () => count(`SELECT COUNT(*) AS total,
                    SUM(content_type = 'movie') AS movies,
                    SUM(content_type = 'series') AS series,
                    SUM(status = 'published') AS published,
                    SUM(status = 'draft') AS drafts,
                    SUM(status = 'archived') AS archived,
                    SUM(content_type = 'series' AND series_running = TRUE) AS seriesRunning,
                    SUM(featured_hero = TRUE) AS hero
             FROM contents`), {}),
      safe('media', () => count(`SELECT COUNT(*) AS total, SUM(health_status = 'unavailable') AS unavailable FROM media_links`), {}),
      safe('resolutions', () => query(`SELECT resolution, COUNT(*) AS count FROM media_links WHERE is_active = TRUE
             GROUP BY resolution ORDER BY count DESC LIMIT 6`), []),
      safe('users', () => count(`SELECT COUNT(*) AS total,
                    SUM(role = 'advertiser') AS advertisers,
                    SUM(created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)) AS newThisMonth
             FROM users WHERE status = 'active'`), {}),
      safe('ads', () => count(`SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending,
                    SUM(status = 'active') AS active, COALESCE(SUM(spent), 0) AS spent FROM ads`), {}),
      safe('views', () => count(`SELECT COALESCE(SUM(view_count), 0) AS total,
                    COALESCE(SUM(CASE WHEN last_viewed_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
                                      THEN view_count ELSE 0 END), 0) AS last7 FROM contents`), {}),
      safe('timeline', () => query(`SELECT DATE(created_at) AS day, COUNT(*) AS contents, 0 AS users FROM contents
             WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 14 DAY) GROUP BY DATE(created_at)
             UNION ALL
             SELECT DATE(created_at) AS day, 0 AS contents, COUNT(*) AS users FROM users
             WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 14 DAY) GROUP BY DATE(created_at)`), []),
      // Portable genre count: read the JSON arrays and tally them in JS so the same
      // query works on MySQL 8 and MariaDB.
      safe('genres', async () => {
        const rows = await query("SELECT genres FROM contents WHERE status = 'published' AND genres IS NOT NULL");
        const tally = new Map();
        for (const row of rows) {
          let list = row.genres;
          if (typeof list === 'string') {
            try { list = JSON.parse(list); } catch { list = []; }
          }
          for (const genre of Array.isArray(list) ? list : []) {
            const key = String(genre || '').trim();
            if (key) tally.set(key, (tally.get(key) || 0) + 1);
          }
        }
        return [...tally.entries()]
          .map(([genre, count]) => ({ genre, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 12);
      }, []),
      safe('topContents', () => query(`SELECT asset_uuid, title, content_type, view_count, poster_url FROM contents
             WHERE status = 'published' ORDER BY view_count DESC, created_at DESC LIMIT 5`), []),
      safe('weeklySeries', () => query(`SELECT asset_uuid, title, current_season, broadcast_note FROM contents
             WHERE content_type = 'series' AND series_running = TRUE AND status = 'published'
             ORDER BY updated_at DESC LIMIT 6`), []),
      safe('activity', () => query('SELECT kind, title, detail, created_at FROM admin_events ORDER BY created_at DESC LIMIT 12'), []),
      safe('health', () => query(`SELECT c.title, mhe.reason, mhe.created_at FROM media_health_events mhe
             JOIN media_links ml ON ml.id = mhe.media_link_id
             JOIN contents c ON c.id = ml.content_id
             ORDER BY mhe.created_at DESC LIMIT 8`), []),
    ]);
    return {
      ...composeOverview({
        contents, media, resolutions, users, ads, views, timeline, genres, topContents, weekly, activity, health,
        weeklySeries: weekly,
      }),
      warnings: overviewWarnings,
    };
  },

  async listContents(filters = {}) {
    const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
    const limit = Math.max(1, Math.min(60, Number.parseInt(filters.limit, 10) || 12));
    const where = ['1 = 1'];
    const params = {};
    if (filters.type && ['movie', 'series'].includes(filters.type)) {
      where.push('c.content_type = :type');
      params.type = filters.type;
    }
    if (filters.status && ['draft', 'published', 'archived'].includes(filters.status)) {
      where.push('c.status = :status');
      params.status = filters.status;
    }
    if (filters.q) {
      where.push("(c.title LIKE :search ESCAPE '!' OR c.original_title LIKE :search ESCAPE '!')");
      params.search = `%${escapeLike(String(filters.q).slice(0, 100))}%`;
    }
    if (filters.hero === '1') where.push('c.featured_hero = TRUE');
    if (filters.running === '1') where.push('c.series_running = TRUE');
    const clause = where.join(' AND ');
    const order = filters.sort === 'views'
      ? 'c.view_count DESC, c.created_at DESC'
      : filters.sort === 'title'
        ? 'c.title ASC'
        : 'c.created_at DESC';
    const rows = await query(
      `SELECT ${CONTENT_COLUMNS},
              (SELECT COUNT(*) FROM media_links ml WHERE ml.content_id = c.id AND ml.is_active = TRUE) AS media_count,
              (SELECT JSON_ARRAYAGG(resolution) FROM (
                  SELECT DISTINCT ml2.resolution FROM media_links ml2
                  WHERE ml2.content_id = c.id AND ml2.is_active = TRUE
                    AND ml2.resolution IS NOT NULL AND ml2.resolution <> ''
                  ORDER BY CAST(REGEXP_REPLACE(ml2.resolution, '[^0-9]', '') AS UNSIGNED) DESC
                  LIMIT 6) qualities) AS qualities
       FROM contents c WHERE ${clause} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    );
    const total = await query(`SELECT COUNT(*) AS total FROM contents c WHERE ${clause}`, params);
    return {
      items: rows.map(listRow),
      pagination: {
        page,
        limit,
        total: Number(total[0].total),
        pages: Math.max(1, Math.ceil(Number(total[0].total) / limit)),
      },
    };
  },

  async getContent(assetId) {
    const rows = await query(
      `SELECT ${CONTENT_COLUMNS} FROM contents c WHERE c.asset_uuid = :assetId LIMIT 1`,
      { assetId },
    );
    assert(rows[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
    const versions = await query(
      'SELECT * FROM content_versions WHERE content_id = :id ORDER BY kind, sort_order, id',
      { id: rows[0].id },
    );
    const links = versions.length
      ? await query(
        `SELECT * FROM content_version_links WHERE version_id IN (${versions.map((v) => `'${Number(v.id)}'`).join(',')})
         ORDER BY COALESCE(season_number, 0), COALESCE(episode_number, 0), id`,
      )
      : [];
    const byVersion = new Map();
    for (const link of links) {
      const key = String(link.version_id);
      if (!byVersion.has(key)) byVersion.set(key, []);
      byVersion.get(key).push(link);
    }
    return {
      content: detailRow(rows[0]),
      versions: versions.map((version) => versionDto(version, byVersion.get(String(version.id)) || [])),
      counts: {
        seasons: rows[0].season_count === null ? null : Number(rows[0].season_count),
        episodes: rows[0].episode_count === null ? null : Number(rows[0].episode_count),
        mediaLinks: links.length,
      },
    };
  },

  async createContent(payload, options = {}) {
    const assetUuid = crypto.randomUUID();
    const item = await withTransaction(async (connection) => {
      if (payload.featuredHero) await clearHeroSlot(connection);
      const [result] = await connection.execute(
        `INSERT INTO contents
          (asset_uuid, content_type, title, original_title, slug, description, imdb_score,
           release_year, last_air_year, series_running, current_season, broadcast_note,
           season_count, episode_count, genres, directors, cast_members, country, network,
           age_rating, runtime_minutes, has_dub, has_sub, poster_url, poster_gallery,
           backdrop_url, trailer_url, stream_url, status, featured_hero, source_chat_id)
         VALUES
          (:assetUuid, :contentType, :title, :originalTitle, :slug, :description, :imdbScore,
           :releaseYear, :lastAirYear, :seriesRunning, :currentSeason, :broadcastNote,
           :seasonCount, :episodeCount, :genres, :directors, :castMembers, :country, :network,
           :ageRating, :runtimeMinutes, :hasDub, :hasSub, :posterUrl, :posterGallery,
           :backdropUrl, :trailerUrl, :streamUrl, :status, :featuredHero, :sourceChatId)`,
        {
          assetUuid,
          contentType: payload.contentType,
          title: payload.titleFa,
          originalTitle: payload.titleEn,
          slug: slugify(payload.titleEn || payload.titleFa, assetUuid),
          description: payload.description,
          imdbScore: payload.imdbScore,
          releaseYear: payload.releaseYear,
          lastAirYear: payload.lastAirYear,
          seriesRunning: payload.seriesRunning,
          currentSeason: payload.currentSeason,
          broadcastNote: payload.broadcastNote,
          seasonCount: payload.seasonCount,
          episodeCount: payload.episodeCount,
          genres: JSON.stringify(payload.genres),
          directors: JSON.stringify(payload.directors),
          castMembers: JSON.stringify(payload.castMembers),
          country: payload.countries.join('، ') || null,
          network: payload.network,
          ageRating: payload.ageRating,
          runtimeMinutes: payload.runtimeMinutes,
          hasDub: payload.hasDub,
          hasSub: payload.hasSub,
          posterUrl: payload.posterUrl,
          posterGallery: JSON.stringify(payload.posterGallery),
          backdropUrl: payload.backdropUrl,
          trailerUrl: payload.trailerUrl,
          streamUrl: payload.streamUrl,
          status: payload.status,
          featuredHero: payload.featuredHero,
          sourceChatId: options.sourceChatId || null,
        },
      );
      await store.writeVersions(connection, result.insertId, payload.versions);
      await store.syncSeriesCounts(connection, result.insertId, payload);
      await logEvent('content', `محتوا ثبت شد: ${payload.titleFa}`,
        `${payload.contentType === 'series' ? 'سریال' : 'فیلم'} · ${payload.status}`, connection);
      return result.insertId;
    });
    const rows = await query(`SELECT ${CONTENT_COLUMNS} FROM contents c WHERE c.id = :id`, { id: item });
    return { content: listRow(rows[0]) };
  },

  async updateContent(assetId, payload) {
    await withTransaction(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT id FROM contents WHERE asset_uuid = :assetId FOR UPDATE',
        { assetId },
      );
      assert(rows[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
      if (payload.featuredHero) await clearHeroSlot(connection);
      await connection.execute(
        `UPDATE contents SET
           content_type = :contentType, title = :title, original_title = :originalTitle,
           description = :description, imdb_score = :imdbScore, release_year = :releaseYear,
           last_air_year = :lastAirYear, series_running = :seriesRunning,
           current_season = :currentSeason, broadcast_note = :broadcastNote,
           season_count = :seasonCount, episode_count = :episodeCount, genres = :genres,
           directors = :directors, cast_members = :castMembers, country = :country,
           network = :network, age_rating = :ageRating, runtime_minutes = :runtimeMinutes,
           has_dub = :hasDub, has_sub = :hasSub, poster_url = :posterUrl,
           poster_gallery = :posterGallery, backdrop_url = :backdropUrl,
           trailer_url = :trailerUrl, stream_url = :streamUrl, status = :status,
           featured_hero = :featuredHero
         WHERE id = :id`,
        {
          id: rows[0].id,
          contentType: payload.contentType,
          title: payload.titleFa,
          originalTitle: payload.titleEn,
          description: payload.description,
          imdbScore: payload.imdbScore,
          releaseYear: payload.releaseYear,
          lastAirYear: payload.lastAirYear,
          seriesRunning: payload.seriesRunning,
          currentSeason: payload.currentSeason,
          broadcastNote: payload.broadcastNote,
          seasonCount: payload.seasonCount,
          episodeCount: payload.episodeCount,
          genres: JSON.stringify(payload.genres),
          directors: JSON.stringify(payload.directors),
          castMembers: JSON.stringify(payload.castMembers),
          country: payload.countries.join('، ') || null,
          network: payload.network,
          ageRating: payload.ageRating,
          runtimeMinutes: payload.runtimeMinutes,
          hasDub: payload.hasDub,
          hasSub: payload.hasSub,
          posterUrl: payload.posterUrl,
          posterGallery: JSON.stringify(payload.posterGallery),
          backdropUrl: payload.backdropUrl,
          trailerUrl: payload.trailerUrl,
          streamUrl: payload.streamUrl,
          status: payload.status,
          featuredHero: payload.featuredHero,
        },
      );
      if (Array.isArray(payload.versions) && payload.versions.length) {
        await connection.execute('DELETE FROM content_versions WHERE content_id = :id', { id: rows[0].id });
        await store.writeVersions(connection, rows[0].id, payload.versions);
      }
      await store.syncSeriesCounts(connection, rows[0].id, payload);
      await logEvent('content', `محتوا ویرایش شد: ${payload.titleFa}`, `وضعیت ${payload.status}`, connection);
    });
    return store.getContent(assetId);
  },

  async deleteContent(assetId) {
    const result = await query('DELETE FROM contents WHERE asset_uuid = :assetId', { assetId });
    assert(result.affectedRows, 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
    await logEvent('content', 'محتوا حذف شد', assetId);
    return { deleted: true };
  },

  async setHero(assetId, enabled) {
    await withTransaction(async (connection) => {
      const [rows] = await connection.execute(
        'SELECT id, title FROM contents WHERE asset_uuid = :assetId FOR UPDATE',
        { assetId },
      );
      assert(rows[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
      if (enabled) {
        await connection.execute('UPDATE contents SET featured_hero = FALSE WHERE featured_hero = TRUE');
      }
      await connection.execute(
        'UPDATE contents SET featured_hero = :enabled WHERE id = :id',
        { enabled: Boolean(enabled), id: rows[0].id },
      );
      await logEvent('content', enabled ? `به بنر هیرو اضافه شد: ${rows[0].title}` : `از بنر هیرو برداشته شد: ${rows[0].title}`, null, connection);
    });
    return { featuredHero: Boolean(enabled) };
  },

  async writeVersions(connection, contentId, versions = []) {
    for (const [index, version] of versions.entries()) {
      const [inserted] = await connection.execute(
        `INSERT INTO content_versions (content_id, kind, title, resolution, sort_order)
         VALUES (:contentId, :kind, :title, :resolution, :sortOrder)`,
        {
          contentId,
          kind: version.kind,
          title: version.title,
          resolution: version.resolution,
          sortOrder: version.sortOrder ?? index,
        },
      );
      for (const link of version.links || []) {
        await connection.execute(
          `INSERT INTO content_version_links
            (version_id, season_number, episode_number, episode_title, label, size_text,
             stream_url, subtitle_url, dub_url, telegram_url, source)
           VALUES
            (:versionId, :season, :episode, :title, :label, :sizeText,
             :streamUrl, :subtitleUrl, :dubUrl, :telegramUrl, :source)`,
          {
            versionId: inserted.insertId,
            season: link.season,
            episode: link.episode,
            title: link.title,
            label: link.label,
            sizeText: link.sizeText,
            streamUrl: link.streamUrl,
            subtitleUrl: link.subtitleUrl,
            dubUrl: link.dubUrl,
            telegramUrl: link.telegramUrl,
            source: link.source || 'manual',
          },
        );
      }
    }
  },

  /**
   * Series counters (seasons / episodes) are derived from the episode links the owner
   * actually created, unless they typed explicit numbers.
   */
  async syncSeriesCounts(connection, contentId, payload) {
    if (payload.contentType !== 'series') return;
    const [rows] = await connection.execute(
      // Distinct (season, episode) pairs: an episode with a dub and a sub is still one.
      `SELECT COUNT(DISTINCT season_number) AS seasons,
              COUNT(DISTINCT CONCAT(COALESCE(season_number, 0), '-', episode_number)) AS episodes
       FROM content_version_links vcl
       JOIN content_versions cv ON cv.id = vcl.version_id
       WHERE cv.content_id = :contentId AND vcl.episode_number IS NOT NULL`,
      { contentId },
    );
    const derivedSeasons = Number(rows[0]?.seasons || 0) || null;
    const derivedEpisodes = Number(rows[0]?.episodes || 0) || null;
    await connection.execute(
      `UPDATE contents SET
         season_count = COALESCE(:seasonCount, season_count, :derivedSeasons),
         episode_count = COALESCE(:episodeCount, episode_count, :derivedEpisodes)
       WHERE id = :contentId`,
      {
        seasonCount: payload.seasonCount,
        episodeCount: payload.episodeCount,
        derivedSeasons,
        derivedEpisodes,
        contentId,
      },
    );
  },

  /**
   * The owner console's "pull links from the bot" action.
   *
   * Bot ingestion writes `media_links`, so those links already serve the public
   * download picker; this projects them into the console's version tree as well
   * (idempotently, keyed by `media_link_id`) so the owner sees one link model.
   */
  async syncFromMedia(assetId, payload = {}) {
    const content = await query('SELECT id, title FROM contents WHERE asset_uuid = :assetId LIMIT 1', { assetId });
    assert(content[0], 404, 'CONTENT_NOT_FOUND', 'اثر پیدا نشد.');
    const rows = await query(
      `SELECT ml.* FROM media_links ml
       WHERE ml.content_id = :contentId AND ml.is_active = TRUE
       ORDER BY COALESCE(ml.season_number, 0), COALESCE(ml.episode_number, 0),
                FIELD(ml.audio_type, 'dubbed', 'hard_sub', 'soft_sub', 'original'),
                CAST(REGEXP_REPLACE(ml.resolution, '[^0-9]', '') AS UNSIGNED) DESC`,
      { contentId: content[0].id },
    );
    let imported = 0;
    await withTransaction(async (connection) => {
      for (const row of rows) {
        const kind = row.audio_type === 'dubbed' ? 'dub' : 'sub';
        const quality = row.resolution || row.quality_label || 'نسخه';
        const [versions] = await connection.execute(
          'SELECT id FROM content_versions WHERE content_id = :contentId AND kind = :kind AND title = :title LIMIT 1',
          { contentId: content[0].id, kind, title: quality },
        );
        let versionId = versions[0]?.id;
        if (!versionId) {
          const [inserted] = await connection.execute(
            `INSERT INTO content_versions (content_id, kind, title, resolution, sort_order)
             VALUES (:contentId, :kind, :title, :resolution, :sortOrder)`,
            {
              contentId: content[0].id,
              kind,
              title: quality,
              resolution: row.resolution,
              sortOrder: Number(String(row.resolution || '').replace(/\D/g, '')) || 0,
            },
          );
          versionId = inserted.insertId;
        }
        const result = await connection.execute(
          `INSERT INTO content_version_links
             (version_id, season_number, episode_number, label, size_text, stream_url,
              subtitle_url, dub_url, telegram_url, media_link_id, source)
           VALUES
             (:versionId, :season, :episode, :label, :sizeText, :streamUrl,
              :subtitleUrl, :dubUrl, :telegramUrl, :mediaLinkId, 'telegram_bot')
           ON DUPLICATE KEY UPDATE
             telegram_url = VALUES(telegram_url), subtitle_url = VALUES(subtitle_url),
             dub_url = VALUES(dub_url), stream_url = VALUES(stream_url)`,
          {
            versionId,
            season: row.season_number,
            episode: row.episode_number,
            label: [row.quality_label, row.encoder].filter(Boolean).join(' · ') || null,
            sizeText: row.file_size_bytes ? `${(Number(row.file_size_bytes) / 1_073_741_824).toFixed(2)} GB` : null,
            streamUrl: row.stream_url,
            subtitleUrl: row.subtitle_link_primary,
            dubUrl: row.audio_type === 'dubbed' ? row.tg_link_primary : null,
            telegramUrl: row.tg_link_primary,
            mediaLinkId: row.id,
          },
        );
        imported += result.affectedRows;
      }
      const uniqueEpisodes = new Set(rows.filter((row) => row.episode_number)
        .map((row) => `${row.season_number || 1}-${row.episode_number}`));
      if (uniqueEpisodes.size) {
        await connection.execute(
          `UPDATE contents SET
             season_count = COALESCE(season_count, :seasons),
             episode_count = COALESCE(episode_count, :episodes)
           WHERE id = :contentId`,
          {
            seasons: new Set(rows.map((row) => row.season_number || 1)).size,
            episodes: uniqueEpisodes.size,
            contentId: content[0].id,
          },
        );
      }
      await logEvent('media', `لینک‌های رسانه همگام شد: ${content[0].title}`, `${rows.length} لینک در ربات`, connection);
    });
    return { imported, scanned: rows.length, ...(await store.getContent(assetId)) };
  },

  async countContentsThisMonth() {
    const rows = await query(
      'SELECT COUNT(*) AS total FROM contents WHERE created_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 30 DAY)',
    );
    return Number(rows[0].total);
  },
};

module.exports = { store, logEvent, slugify, escapeLike, listRow };
