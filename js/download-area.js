// Download領域の可視化およびタイル/GeoJSONファイル生成
// - 各ポイントを中心に半径(z=17/z=18)の円を地図に描画
// - 「Download領域の指定ファイルを出力」で tile_buffers.geojson と tile_manifest.json を出力
import { CONFIG } from './config.js';

const DA = CONFIG.DOWNLOAD_AREA;

export class DownloadAreaManager {
    constructor(mapManager, gpsDataManager) {
        this.mapManager = mapManager;
        this.gpsDataManager = gpsDataManager;
        this.bufferLayer = L.layerGroup().addTo(this.mapManager.getMap());
    }

    // 「Download領域の算出から除外」以外のポイントを返す
    getEligiblePoints() {
        return this.gpsDataManager.getAllPoints()
            .filter(p => p.category !== CONFIG.CATEGORIES.EXCLUDED);
    }

    // 円の表示を更新
    updateCircles() {
        this.bufferLayer.clearLayers();
        const points = this.getEligiblePoints();

        for (const p of points) {
            // z=17 バッファ
            L.circle([p.lat, p.lng], {
                radius: DA.BUFFER_M_Z17,
                ...CONFIG.BUFFER_CIRCLE_Z17_STYLE
            }).addTo(this.bufferLayer);

            // z=18 バッファ
            L.circle([p.lat, p.lng], {
                radius: DA.BUFFER_M_Z18,
                ...CONFIG.BUFFER_CIRCLE_Z18_STYLE
            }).addTo(this.bufferLayer);
        }
    }

    // 円のポリゴン近似（[lng, lat] の配列、最後の点で閉じる）
    circlePolygon(lat, lng, radiusM, vertices = DA.CIRCLE_VERTICES) {
        const coords = [];
        const latRad = lat * Math.PI / 180;
        for (let i = 0; i < vertices; i++) {
            const angle = (i / vertices) * 2 * Math.PI;
            const dx = radiusM * Math.cos(angle);
            const dy = radiusM * Math.sin(angle);
            const dLat = (dy / DA.EARTH_RADIUS_M) * 180 / Math.PI;
            const dLng = (dx / (DA.EARTH_RADIUS_M * Math.cos(latRad))) * 180 / Math.PI;
            coords.push([lng + dLng, lat + dLat]);
        }
        coords.push(coords[0]);
        return coords;
    }

    // tile_buffers.geojson を生成
    generateTileBuffersGeoJSON() {
        const points = this.getEligiblePoints();
        const features = [];
        for (const p of points) {
            features.push({
                type: 'Feature',
                properties: { layer: DA.LAYER_KEY_Z17, buffer_m: DA.BUFFER_M_Z17 },
                geometry: {
                    type: 'Polygon',
                    coordinates: [this.circlePolygon(p.lat, p.lng, DA.BUFFER_M_Z17)]
                }
            });
            features.push({
                type: 'Feature',
                properties: { layer: DA.LAYER_KEY_Z18, buffer_m: DA.BUFFER_M_Z18 },
                geometry: {
                    type: 'Polygon',
                    coordinates: [this.circlePolygon(p.lat, p.lng, DA.BUFFER_M_Z18)]
                }
            });
        }
        return {
            type: 'FeatureCollection',
            metadata: {
                version: DA.MANIFEST_VERSION,
                z17_layer: { buffer_m: DA.BUFFER_M_Z17, max_zoom: DA.Z17_MAX_ZOOM, min_zoom: DA.Z17_MIN_ZOOM },
                z18_layer: { buffer_m: DA.BUFFER_M_Z18, max_zoom: DA.Z18_MAX_ZOOM, min_zoom: DA.Z18_MIN_ZOOM }
            },
            features
        };
    }

    // 緯度経度→XYZタイル座標
    lonLatToTile(lon, lat, z) {
        const n = 2 ** z;
        const x = Math.floor((lon + 180) / 360 * n);
        const latRad = lat * Math.PI / 180;
        const y = Math.floor(
            (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n
        );
        return [x, y];
    }

    // タイル座標→緯度経度bbox
    tileToBBox(x, y, z) {
        const n = 2 ** z;
        const lonW = x / n * 360 - 180;
        const lonE = (x + 1) / n * 360 - 180;
        const latN = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI;
        const latS = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180 / Math.PI;
        return { lonW, lonE, latN, latS };
    }

    // Haversine距離 (m)
    haversineM(lat1, lon1, lat2, lon2) {
        const φ1 = lat1 * Math.PI / 180;
        const φ2 = lat2 * Math.PI / 180;
        const dφ = (lat2 - lat1) * Math.PI / 180;
        const dλ = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dφ / 2) ** 2 +
                  Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
        return 2 * DA.EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
    }

    // 円とタイルbboxの交差判定（最近接点をクランプで求めて距離評価）
    circleIntersectsTile(lat, lon, radiusM, bbox) {
        const clampedLat = Math.max(bbox.latS, Math.min(lat, bbox.latN));
        const clampedLon = Math.max(bbox.lonW, Math.min(lon, bbox.lonE));
        const dist = this.haversineM(lat, lon, clampedLat, clampedLon);
        return dist <= radiusM;
    }

    // 1点について該当タイルを列挙
    tilesForPoint(lat, lon, radiusM, z) {
        const latRad = lat * Math.PI / 180;
        const dLat = (radiusM / DA.EARTH_RADIUS_M) * 180 / Math.PI;
        const dLon = (radiusM / (DA.EARTH_RADIUS_M * Math.cos(latRad))) * 180 / Math.PI;

        const [x1] = this.lonLatToTile(lon - dLon, lat, z);
        const [x2] = this.lonLatToTile(lon + dLon, lat, z);
        const [, y1] = this.lonLatToTile(lon, lat + dLat, z); // 北側はy小
        const [, y2] = this.lonLatToTile(lon, lat - dLat, z); // 南側はy大

        const tiles = [];
        for (let x = x1; x <= x2; x++) {
            for (let y = y1; y <= y2; y++) {
                const bbox = this.tileToBBox(x, y, z);
                if (this.circleIntersectsTile(lat, lon, radiusM, bbox)) {
                    tiles.push([x, y]);
                }
            }
        }
        return tiles;
    }

    // tile_manifest.json を生成
    generateTileManifest() {
        const points = this.getEligiblePoints();
        const z17Set = new Set();
        const z18Set = new Set();

        for (const p of points) {
            for (const [x, y] of this.tilesForPoint(p.lat, p.lng, DA.BUFFER_M_Z17, DA.Z17)) {
                z17Set.add(`${x},${y}`);
            }
            for (const [x, y] of this.tilesForPoint(p.lat, p.lng, DA.BUFFER_M_Z18, DA.Z18)) {
                z18Set.add(`${x},${y}`);
            }
        }

        const tilesFromSet = (s) => Array.from(s)
            .map(k => k.split(',').map(Number))
            .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

        return {
            version: DA.MANIFEST_VERSION,
            source: DA.MANIFEST_SOURCE,
            layers: {
                [DA.LAYER_KEY_Z17]: {
                    z: DA.Z17,
                    buffer_m: DA.BUFFER_M_Z17,
                    tile_count: z17Set.size,
                    tiles: tilesFromSet(z17Set)
                },
                [DA.LAYER_KEY_Z18]: {
                    z: DA.Z18,
                    buffer_m: DA.BUFFER_M_Z18,
                    tile_count: z18Set.size,
                    tiles: tilesFromSet(z18Set)
                }
            }
        };
    }

    // 2つのファイルを出力
    exportFiles() {
        const points = this.getEligiblePoints();
        if (points.length === 0) {
            return { success: false, error: CONFIG.MESSAGES.DOWNLOAD_AREA_EMPTY };
        }

        const geojson = this.generateTileBuffersGeoJSON();
        const manifest = this.generateTileManifest();

        this.downloadJSON(geojson, DA.GEOJSON_FILENAME);
        this.downloadJSON(manifest, DA.MANIFEST_FILENAME);

        return {
            success: true,
            pointCount: points.length,
            z17Count: manifest.layers[DA.LAYER_KEY_Z17].tile_count,
            z18Count: manifest.layers[DA.LAYER_KEY_Z18].tile_count
        };
    }

    downloadJSON(obj, filename) {
        const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}
