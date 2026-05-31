/**
 * GQuick_Server.gs — Q-クイック NEXT
 * 
 * スプレッドシートの既存機能とは完全に独立しつつ、
 * 標準のYouTubeサービスのみを使用して爆速化を実現したバックエンドロジックです。
 */

/**
 * 1. チャンネル設定のリストを取得 (データベース / キャッシュ優先)
 */
function getChannelConfigs() {
    try {
        const cache = CacheService.getUserCache();
        const cacheKey = "CHANNEL_CONFIGS_V4_STANDALONE";
        const cachedConfigs = cache.get(cacheKey);

        // 1. キャッシュがあれば即座に返す
        if (cachedConfigs) {
            try {
                const parsed = JSON.parse(cachedConfigs);
                if (Array.isArray(parsed)) return { success: true, data: parsed };
            } catch (cacheParseErr) {
                console.error("Cache parse error, clearing:", cacheParseErr);
                cache.remove(cacheKey);
            }
        }

        const props = PropertiesService.getUserProperties();
        let dbConfigs = props.getProperty("CHANNEL_DB_V1");
        let configs = [];

        if (dbConfigs) {
            try {
                configs = JSON.parse(dbConfigs);
                if (!Array.isArray(configs)) configs = [];
            } catch (parseErr) {
                console.error("DB JSON parse error, resetting:", parseErr);
                configs = [];
            }
        } else {
            // 4. まったくの新規または初期状態なら、Channels.html から初期移行（マイグレーション）
            console.log("Database empty. Migrating from Channels.html...");
            let content = "";
            try {
                content = HtmlService.createHtmlOutputFromFile('Channels').getContent();
            } catch (e) {
                console.error("Channels.html not found:", e);
                return { success: true, data: [] };
            }

            const channelIds = [];
            const regex = /(?:([^,\n\r<>]+),)?(U[CU][a-zA-Z0-9_-]{22})/g;
            let match;

            while ((match = regex.exec(content)) !== null) {
                let name = (match[1] || "").trim();
                const id = match[2].trim();
                name = name.replace(/<[^>]*>?/gm, '').replace(/[<>]/g, '').trim();

                if (!channelIds.includes(id)) {
                    channelIds.push(id);
                    const hasLabel = (name && name !== "取得中...");
                    configs.push({
                        id: id,
                        sheetName: hasLabel ? name : "取得中...",
                        name: hasLabel ? name : "取得中..."
                    });
                }
            }
        }

        if (configs.length === 0) return { success: true, data: [] };

        // 名前の補完 (YouTube API) - 「取得中...」または名前が空のものを対象
        const needsNameIds = configs
            .filter(c => c.id && (c.name === "取得中..." || !c.name))
            .map(c => c.id);

        if (needsNameIds.length > 0) {
            try {
                for (let i = 0; i < needsNameIds.length; i += 50) {
                    const batch = needsNameIds.slice(i, i + 50);
                    const res = YouTube.Channels.list('snippet', { id: batch.join(',') });
                    if (res.items) {
                        res.items.forEach(ch => {
                            const config = configs.find(c => c.id === ch.id);
                            if (config) {
                                config.name = ch.snippet.title;
                                config.sheetName = ch.snippet.title;
                            }
                        });
                    }
                }
            } catch (e) {
                console.error("Official Name Fetch Error:", e);
            }
            // ループ外で1回だけ保存
            try {
                props.setProperty("CHANNEL_DB_V1", JSON.stringify(configs));
            } catch (e) {
                console.error("DB Save Error:", e);
            }
        }

        try {
            const configsJson = JSON.stringify(configs);
            if (configsJson.length < 100000) { // 100KB以下ならキャッシュ保存
                cache.put(cacheKey, configsJson, 21600);
            }
        } catch (cacheErr) {
            console.error("Cache put error:", cacheErr);
        }
        return { success: true, data: configs };

    } catch (e) {
        console.error(e);
        return { success: false, error: "チャネル情報の取得に失敗: " + e.message };
    }
}

/**
 * チャンネル情報を保存 (PropertiesService)
 * @param {Array} configs 
 */
function saveChannelConfigs(configs) {
    try {
        if (!Array.isArray(configs)) throw new Error("無効なデータ形式です");

        // データベースを更新
        PropertiesService.getUserProperties().setProperty("CHANNEL_DB_V1", JSON.stringify(configs));

        // キャッシュをクリアして再構築を促す
        clearScriptCache();

        return { success: true };
    } catch (e) {
        console.error("Save Error:", e);
        return { success: false, error: e.message };
    }
}

/**
 * 2. 指定されたチャンネル群の最新動画を取得 (並列実行用ユニット)
 */
function fetchVideosBatch(configs) {
    const allVideoIds = [];
    const videoInfoMap = {};
    const errors = [];
    const cache = CacheService.getUserCache();
    const token = ScriptApp.getOAuthToken();

    // 1. 各チャンネルのプレイリストIDを特定し、リクエストを準備
    const playlistRequests = configs.map(config => {
        const channelId = config.id;
        let plId = cache.get("PLID_" + channelId);

        if (!plId) {
            // IDが既知の形式ならUUに変換、そうでなければAPIで取得
            if (channelId && channelId.startsWith("UC")) {
                plId = channelId.replace(/^UC/, "UU");
                cache.put("PLID_" + channelId, plId, 21600);
            }
        }

        const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${plId}&maxResults=50`;
        return {
            url: url,
            method: "get",
            headers: { "Authorization": "Bearer " + token },
            muteHttpExceptions: true,
            userContext: config
        };
    });

    // 2. プレイリスト情報を一括で並列取得
    try {
        const responses = UrlFetchApp.fetchAll(playlistRequests);
        responses.forEach((res, index) => {
            const config = playlistRequests[index].userContext;
            const content = res.getContentText();
            const json = JSON.parse(content);

            if (res.getResponseCode() !== 200) {
                // UU形式で失敗した場合は、公式APIで uploads プレイリストを探して再試行（フォールバック）
                try {
                    const chRes = YouTube.Channels.list('contentDetails', { id: config.id });
                    if (chRes.items && chRes.items.length > 0) {
                        const correctPlId = chRes.items[0].contentDetails.relatedPlaylists.uploads;
                        cache.put("PLID_" + config.id, correctPlId, 21600);
                        
                        // 今回はスキップし、リトライ時にキャッシュが効くようにする
                        // （またはこの場で再度 fetch するが、シンプルさのためエラー記録に留める）
                        errors.push(`${config.name}: 初期取得失敗。プレイリストIDを修正しました。再試行してください。`);
                    } else {
                        throw new Error(json.error ? json.error.message : "取得エラー");
                    }
                } catch (e) {
                    errors.push(`${config.name}: ${e.message}`);
                }
                return;
            }

            if (json.items && json.items.length > 0) {
                json.items.forEach(item => {
                    const title = item.snippet.title;
                    if (!title || title === 'Deleted video' || title === 'Private video') return;

                    const vid = item.snippet.resourceId.videoId;
                    if (!videoInfoMap[vid]) {
                        videoInfoMap[vid] = {
                            id: vid,
                            title: title,
                            publishedAt: item.snippet.publishedAt,
                            channelTitle: item.snippet.channelTitle,
                            channelId: config.id,
                            thumbnail: (item.snippet.thumbnails && (item.snippet.thumbnails.medium || item.snippet.thumbnails.default) || {}).url || ""
                        };
                        allVideoIds.push(vid);
                    }
                });
            }
        });
    } catch (e) {
        console.error("Parallel Fetch Error (PlaylistItems):", e);
        return { success: false, error: "並列取得失敗: " + e.message };
    }

    // 3. 動画の詳細（再生数・時間）を並列で一括取得
    const finalData = [];
    if (allVideoIds.length > 0) {
        const uniqueIds = Array.from(new Set(allVideoIds));
        const videoBatches = [];
        for (let i = 0; i < uniqueIds.length; i += 50) {
            videoBatches.push(uniqueIds.slice(i, i + 50));
        }

        const videoRequests = videoBatches.map(batch => {
            const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${batch.join(',')}`;
            return {
                url: url,
                method: "get",
                headers: { "Authorization": "Bearer " + token },
                muteHttpExceptions: true
            };
        });

        try {
            const vResponses = UrlFetchApp.fetchAll(videoRequests);
            vResponses.forEach(res => {
                if (res.getResponseCode() === 200) {
                    const vJson = JSON.parse(res.getContentText());
                    if (vJson.items) {
                        vJson.items.forEach(v => {
                            const meta = videoInfoMap[v.id];
                            if (meta) {
                                finalData.push({
                                    id: v.id,
                                    title: meta.title,
                                    publishedAt: meta.publishedAt,
                                    channelTitle: meta.channelTitle,
                                    channelId: meta.channelId,
                                    thumbnail: meta.thumbnail,
                                    viewCount: parseInt((v.statistics && v.statistics.viewCount) || 0, 10),
                                    duration: formatISO8601Duration(v.contentDetails && v.contentDetails.duration),
                                    url: `https://www.youtube.com/watch?v=${v.id}`
                                });
                            }
                        });
                    }
                }
            });
        } catch (e) {
            console.error("Parallel Fetch Error (VideoDetails):", e);
        }
    }

    if (finalData.length === 0 && errors.length > 0) {
        return { success: false, error: "取得失敗: " + errors[0] };
    }

    return { success: true, data: finalData };
}

/**
 * 3. 指定されたチャンネルの動画を取得 (個別表示用・ページネーション対応)
 */
function fetchChannelVideos(channelId, channelName, pageToken) {
    const cache = CacheService.getUserCache();
    let videoInfoMap = {};
    let allVideoIds = [];
    let nextPageToken = null;

    let plId = cache.get("PLID_" + channelId);
    if (!plId) {
        try {
            const res = YouTube.Channels.list('contentDetails', { id: channelId });
            if (res.items && res.items.length > 0) {
                plId = res.items[0].contentDetails.relatedPlaylists.uploads;
                cache.put("PLID_" + channelId, plId, 21600);
            }
        } catch (e) {
            return { success: false, error: "チャンネル情報の取得に失敗: " + e.message };
        }
    }
    if (!plId) return { success: false, error: "プレイリストが見つかりません" };

    try {
        const params = {
            playlistId: plId,
            maxResults: 50
        };
        if (pageToken) params.pageToken = pageToken;

        const playlistRes = YouTube.PlaylistItems.list('snippet', params);
        nextPageToken = playlistRes.nextPageToken || null;

        if (playlistRes.items && playlistRes.items.length > 0) {
            playlistRes.items.forEach(item => {
                const title = item.snippet.title;
                // 削除済み・非公開動画を除外
                if (!title || title === 'Deleted video' || title === 'Private video') return;
                const meta = {
                    id: item.snippet.resourceId.videoId,
                    title: title,
                    publishedAt: item.snippet.publishedAt,
                    channelTitle: item.snippet.channelTitle,
                    thumbnail: (item.snippet.thumbnails && (item.snippet.thumbnails.medium || item.snippet.thumbnails.default) || {}).url || ""
                };
                allVideoIds.push(meta.id);
                videoInfoMap[meta.id] = meta;
            });
        }
    } catch (e) {
        console.error("fetchChannelVideos Error:", e);
        return { success: false, error: "取得失敗: " + e.message };
    }

    const finalData = [];
    if (allVideoIds.length > 0) {
        try {
            const uniqueIds = Array.from(new Set(allVideoIds));
            // 50件以下なので1回で取得可能だが、念のためバッチ処理
            for (let i = 0; i < uniqueIds.length; i += 50) {
                const batch = uniqueIds.slice(i, i + 50);
                const details = YouTube.Videos.list('statistics,contentDetails', { id: batch.join(',') });
                if (details.items) {
                    details.items.forEach(v => {
                        const meta = videoInfoMap[v.id];
                        if (meta) {
                            finalData.push({
                                id: v.id,
                                title: meta.title,
                                publishedAt: meta.publishedAt,
                                channelTitle: meta.channelTitle,
                                channelId: channelId, // ★ 追加
                                thumbnail: meta.thumbnail,
                                viewCount: parseInt((v.statistics && v.statistics.viewCount) || 0, 10),
                                duration: formatISO8601Duration(v.contentDetails && v.contentDetails.duration),
                                url: `https://www.youtube.com/watch?v=${v.id}`
                            });
                        }
                    });
                }
            }
        } catch (e) {
            console.error("Error fetching video details: " + e.message);
            return { success: false, error: "詳細データ取得失敗: " + e.message };
        }
    }

    return { success: true, data: finalData, nextPageToken: nextPageToken };
}

function formatISO8601Duration(duration) {
    if (!duration) return "0:00";
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return "0:00";
    const h = parseInt(match[1], 10) || 0;
    const m = parseInt(match[2], 10) || 0;
    const s = parseInt(match[3], 10) || 0;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * 4. チャンネルIDから公式のチャンネル名を取得 (キャッシュ対応)
 */
function getOfficialChannelNames(channelIds) {
    if (!channelIds || channelIds.length === 0) return {};

    const cache = CacheService.getUserCache();
    const result = {};
    const missingIds = [];

    // キャッシュから確認
    channelIds.forEach(id => {
        const cachedName = cache.get("CH_NAME_V4_" + id);
        if (cachedName) {
            result[id] = cachedName;
        } else {
            missingIds.push(id);
        }
    });

    // 足りない分をAPIで取得
    if (missingIds.length > 0) {
        try {
            // API制限（1回50件まで）に対応
            for (let i = 0; i < missingIds.length; i += 50) {
                const batch = missingIds.slice(i, i + 50);
                const response = YouTube.Channels.list('snippet', { id: batch.join(',') });
                if (response.items) {
                    response.items.forEach(item => {
                        const name = item.snippet.title;
                        result[item.id] = name;
                        // 6時間キャッシュ
                        cache.put("CH_NAME_V4_" + item.id, name, 21600);
                    });
                }
            }
        } catch (e) {
            console.error("YouTube.Channels.list Error:", e);
        }
    }

    return result;
}


/**
 * 5. サーバー側のキャッシュを明示的にクリアする (設定反映用)
 */
function clearScriptCache() {
    try {
        const cache = CacheService.getUserCache();
        cache.remove("CHANNEL_CONFIGS_V4_STANDALONE");
        return { success: true };
    } catch (e) {
        console.error("Cache Clear Error:", e);
        return { success: false, error: e.message };
    }
}

/**
 * 6. @handle形式のチャンネルIDを解決してUCチャンネルIDを返す
 * @param {Array<string>} handles "@handle" 形式の文字列配列
 * @returns {Object} { handle: { id, name } } のマップ
 */
function resolveChannelHandles(handles) {
    const result = {};
    if (!handles || handles.length === 0) return result;
    handles.forEach(h => {
        const handle = h.startsWith('@') ? h.slice(1) : h;
        try {
            const res = YouTube.Channels.list('snippet', { forHandle: handle });
            if (res.items && res.items.length > 0) {
                result[h] = {
                    id: res.items[0].id,
                    name: res.items[0].snippet.title
                };
            }
        } catch (e) {
            console.error('Handle resolve error for ' + h + ':', e);
        }
    });
    return result;
}

function doGet(e) {
    return HtmlService.createTemplateFromFile('GQuick_UI')
        .evaluate()
        .setTitle('Q-クイック NEXT')
        .addMetaTag('viewport', 'width=device-width, initial-scale=1')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
