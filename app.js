/**
 * REI-Map メインアプリケーションロジック
 *
 * 主な機能:
 *  - Mapbox GL JS を使った地図表示・操作（ベースマップ切替、3D建物、地形）
 *  - buildingInfo.xlsx から物件データを読み込み、マップにピン表示
 *  - 物件の詳細ポップアップ表示（Chart.js による利回り・稼働率・RevPAR グラフ）
 *  - 範囲フィルタ（矩形描画 / 円選択 / 市区町村選択）
 *  - サイドバーによる物件一覧・フィルタ（アセット・契約形態・利回り・竣工年月）
 *  - レイヤー表示切替（用途地域・地価公示・将来人口・駅乗降客数・ハザードマップ）
 *  - Excel / PDF（プレビュー）出力、URL共有
 */

mapboxgl.accessToken = MAPBOX_TOKEN;

// 1. 状態管理
const state = {
    geoData: { type: 'FeatureCollection', features: [] },
    currentPopup: null,
    isDrawingMode: false,
    isCircleMode: false,
    circleCenter: null,
    circlePolygon: null,
    isMunicipalityMode: false,
    municipalityPolygons: null,  // 選択中の市区町村フィーチャ配列
    municipalityName: null,
    _municipalityGeoJSON: null,  // 読み込み済みGeoJSON
    assetTypes: ['オフィス', 'レジデンス', '商業施設', 'ホテル', '物流施設'],
    currentFilteredData: [],
    stationData: [],
    checkedIds: new Set()
};

// 不動産情報ライブラリ API の取得対象エリア（都道府県コード）
// 他の都市に対応する場合はここにコードを追加する
// 例: '27'=大阪府, '23'=愛知県, '14'=神奈川県, '11'=埼玉県
const REINFOLIB_TARGET_AREA = '13'; // 東京都

// URL パラメータから画面状態を同期的に復元（マップ生成前にチェックボックス等をセット）
(function initFromUrl() {
    const p = new URLSearchParams(location.search);
    if (!p.toString()) return;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    if (p.get('kw'))    set('keyword-search', p.get('kw'));
    if (p.get('asset')) set('filter-asset', p.get('asset'));
    if (p.get('style')) set('basemap-select', p.get('style'));
    (p.get('layers') || '').split(',').filter(Boolean).forEach(l => {
        const el = document.getElementById('toggle-' + l);
        if (el) el.checked = true;
    });
    (p.get('hazards') || '').split(',').filter(Boolean).forEach(l => {
        const el = document.querySelector(`.hazard-chk[data-layer="${l}"]`);
        if (el) el.checked = true;
    });
    if (p.get('circle')) {
        const [clng, clat, r] = p.get('circle').split(',').map(Number);
        if (!isNaN(clng) && !isNaN(clat) && !isNaN(r)) {
            state.circlePolygon = turf.circle([clng, clat], r, { steps: 64, units: 'kilometers' });
        }
    }
})();

// URL パラメータからマップ位置を復元（load 後に適用）
function restoreMapPosition() {
    const p = new URLSearchParams(location.search);
    if (!p.toString()) return;
    const lng = parseFloat(p.get('lng')), lat = parseFloat(p.get('lat'));
    const zoom = parseFloat(p.get('zoom')), pitch = parseFloat(p.get('pitch')), bearing = parseFloat(p.get('bearing'));
    if (!isNaN(lng) && !isNaN(lat)) {
        map.jumpTo({
            center: [lng, lat],
            zoom:    !isNaN(zoom)    ? zoom    : map.getZoom(),
            pitch:   !isNaN(pitch)   ? pitch   : map.getPitch(),
            bearing: !isNaN(bearing) ? bearing : map.getBearing()
        });
    }
    const styleUrl = p.get('style');
    if (styleUrl && styleUrl !== 'mapbox://styles/mapbox/light-v11') map.setStyle(styleUrl);
}

const map = new mapboxgl.Map({
    container: 'map',
    style: document.getElementById('basemap-select')?.value || 'mapbox://styles/mapbox/light-v11',
    center: [139.744, 35.688], // 千代田区中心付近
    zoom: 14.5,
    pitch: 50,
    projection: 'globe',
    preserveDrawingBuffer: true
});

// コントロール設定
map.addControl(new MapboxLanguage({ defaultLanguage: 'ja' }));

// リセットビューコントロール
class ResetViewControl {
    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = '初期ビューに戻す';
        btn.style.cssText = 'font-size:16px; line-height:1;';
        btn.textContent = '⌂';
        btn.onclick = () => {
            map.flyTo({ center: [139.744, 35.688], zoom: 14.5, pitch: 50, bearing: 0, duration: 1000 });
        };
        this._container.appendChild(btn);
        return this._container;
    }
    onRemove() { this._container.parentNode.removeChild(this._container); this._map = undefined; }
}

// bottom-right は prepend で挿入されるため、後から追加したものが上に来る
// 上から順：リセット → ズーム(+/-) → 方位磁針 → 尺表示 にするため、逆順で addControl
map.addControl(new mapboxgl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
map.addControl(new mapboxgl.NavigationControl({ showZoom: false, showCompass: true }), 'bottom-right');
map.addControl(new mapboxgl.NavigationControl({ showZoom: true, showCompass: false }), 'bottom-right');
map.addControl(new ResetViewControl(), 'bottom-right');

const geocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken, mapboxgl: mapboxgl, placeholder: '場所を検索...', marker: true,
    countries: 'jp',
    language: 'ja'
});
document.getElementById('geocoder').appendChild(geocoder.onAdd(map));
geocoder.on('result', () => {
    const btn = document.getElementById('geocoder-clear-btn');
    if (btn) btn.style.display = 'block';
});
geocoder.on('clear', () => {
    const btn = document.getElementById('geocoder-clear-btn');
    if (btn) btn.style.display = 'none';
});

// 2. 描画コントロール
const draw = new MapboxDraw({ 
    displayControlsDefault: false, 
    controls: { polygon: true, trash: true },
    styles: [
        { 'id': 'gl-draw-line', 'type': 'line', 'filter': ['all', ['==', '$type', 'LineString']], 'paint': { 'line-color': '#3b82f6', 'line-width': 2 } },
        { 'id': 'gl-draw-polygon-fill', 'type': 'fill', 'filter': ['all', ['==', '$type', 'Polygon']], 'paint': { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 } },
        { 'id': 'gl-draw-polygon-stroke-active', 'type': 'line', 'filter': ['all', ['==', '$type', 'Polygon']], 'paint': { 'line-color': '#3b82f6', 'line-width': 2 } },
        { 'id': 'gl-draw-polygon-and-line-vertex-active', 'type': 'circle', 'filter': ['all', ['==', 'meta', 'vertex'], ['==', '$type', 'Point']], 'paint': { 'circle-radius': 4, 'circle-color': '#3b82f6' } }
    ]
});
map.addControl(draw, 'top-left');

// ポリゴン描画完了・更新時にフィルタを適用
map.on('draw.create', () => {
    state.isDrawingMode = false;
    map.getCanvas().style.cursor = '';
    const btn = document.getElementById('btn-draw-toggle');
    if (btn) { btn.innerHTML = '🗑️ 選択解除'; btn.classList.remove('active-cancel'); btn.classList.add('active'); }
    applyFilters();
});
map.on('draw.update', applyFilters);
map.on('draw.delete', applyFilters);

/**
 * 3. データの読み込み
 */
async function loadExcelData() {
    try {
        const response = await fetch('./buildingInfo.xlsx'); 
        const arrayBuffer = await response.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const jsonData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

        state.geoData.features = jsonData.map((item, index) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [parseFloat(item['経度']), parseFloat(item['緯度'])] },
            properties: { 
                ...item,
                id: item['物件ID'] || `ID-${index}`,
                assetType: item['アセットタイプ'] || 'オフィス',
                name: item['物件名'] || '無題',
                address: item['物件所在地'] || ''
            }
        }));
        populateContractFilter();
        setupMapContent();
        applyFilters();
    } catch (e) { console.error("Excel load error:", e); }
}

/**
 * 4. マップコンテンツ
 */
async function setupMapContent() {
    await Promise.all(state.assetTypes.map(type => {
        return new Promise(resolve => {
            const img = new Image();
            img.src = getSvgIcon(getAssetColor(type), type);
            img.onload = () => { if(!map.hasImage(`icon-${type}`)) map.addImage(`icon-${type}`, img); resolve(); };
        });
    }));

    if (!map.getSource('buildings')) map.addSource('buildings', { type: 'geojson', data: state.geoData });
    if (!map.getLayer('unclustered-point')) {
        map.addLayer({
            id: 'unclustered-point', type: 'symbol', source: 'buildings',
            layout: { 'icon-image': ['concat', 'icon-', ['get', 'assetType']], 'icon-size': 0.9, 'icon-allow-overlap': true }
        });
    }

    setupAnalysisLayers();
    setupStationLayer();
    setupMunicipalityLayer();
    setupInteractions();
    updateHazards();
}

/**
 * 5. 分析レイヤー（用途地域・地価・将来人口・3D建物）の構築
 */
function setupAnalysisLayers() {
    // --- 用途地域 ---
    if (!map.getSource('zoning')) map.addSource('zoning', { type: 'geojson', data: './tokyo_zoning.geojson' });
    if (!map.getLayer('zoning-layer')) {
        map.addLayer({
            id: 'zoning-layer', type: 'fill', source: 'zoning',
            paint: {
                'fill-color': ['match', ['to-string', ['get', 'A29_004']], 
                    '1', '#009944', '2', '#006837', '3', '#8DCF3F', '4', '#3CB371', 
                    '5', '#FFFF00', '6', '#FFCC00', '7', '#F7931E', '8', '#A6D96A', 
                    '9', '#F49AC1', '10', '#E60012', '11', '#906BB5', '12', '#009ED9', 
                    '13', '#283C8E', '21', '#E60012', '#cccccc'],
                'fill-opacity': 0.4
            },
            layout: { visibility: document.getElementById('toggle-zoning')?.checked ? 'visible' : 'none' }
        }, 'unclustered-point');
    }

    // --- 地価公示 ---
    if (!map.getSource('landprice')) map.addSource('landprice', { type: 'geojson', data: './tokyo_landprice.geojson' });
    if (!map.getLayer('landprice-layer')) {
        map.addLayer({
            id: 'landprice-layer', type: 'circle', source: 'landprice',
            paint: { 'circle-radius': 6, 'circle-color': '#d97706', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' },
            layout: { visibility: document.getElementById('toggle-landprice')?.checked ? 'visible' : 'none' }
        });
    }
    if (!map.getLayer('landprice-label')) {
        map.addLayer({
            id: 'landprice-label', type: 'symbol', source: 'landprice',
            layout: {
                'text-field': ['case',
                    ['>', ['to-number', ['get', 'L01_005']], 0],
                    ['concat',
                        ['get', 'L01_024'], ['to-string', ['to-number', ['get', 'L01_005']]], '-', ['to-string', ['to-number', ['get', 'L01_006']]], '\n',
                        ['to-string', ['round', ['/', ['get', 'L01_008'], 10000]]], '万円/㎡'
                    ],
                    ['concat',
                        ['get', 'L01_024'], '-', ['to-string', ['to-number', ['get', 'L01_006']]], '\n',
                        ['to-string', ['round', ['/', ['get', 'L01_008'], 10000]]], '万円/㎡'
                    ]
                ],
                'text-size': 11, 'text-offset': [0, -1.5], 'text-anchor': 'bottom',
                'text-line-height': 1.3,
                'visibility': document.getElementById('toggle-landprice')?.checked ? 'visible' : 'none'
            },
            paint: { 'text-color': '#d97706', 'text-halo-color': '#ffffff', 'text-halo-width': 2 }
        });
    }

    // --- 地価公示ヒートマップ ---
    if (!map.getLayer('landprice-heat')) {
        map.addLayer({
            id: 'landprice-heat', type: 'heatmap', source: 'landprice',
            paint: {
                // 高価格帯のみが強く効く重み付け（低価格は埋没、高価格は際立つ）
                'heatmap-weight': [
                    'interpolate', ['linear'], ['get', 'L01_008'],
                    0,        0,
                    500000,   0.05,  // 中央値以下はほぼ無視
                    1000000,  0.15,
                    2000000,  0.35,
                    5000000,  0.65,
                    10000000, 0.85,
                    67100000, 1.0
                ],
                // 半径を大きめにしてエリア全体を面的に塗る
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 40, 12, 60, 15, 80],
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 12, 2.5, 15, 4],
                'heatmap-opacity': 0.75,
                // jet カラーマップ（matplotlib 準拠）：透明 → 青 → シアン → 緑 → 黄 → 赤 → 深紅
                'heatmap-color': [
                    'interpolate', ['linear'], ['heatmap-density'],
                    0,    'rgba(0,0,0,0)',
                    0.15, 'rgba(0,0,0,0)',           // 低密度帯は透明のまま
                    0.25, 'rgba(0,0,255,0.8)',        // blue
                    0.4,  'rgba(0,255,255,0.85)',     // cyan
                    0.55, 'rgba(0,255,0,0.9)',        // green
                    0.7,  'rgba(255,255,0,0.93)',     // yellow
                    0.85, 'rgba(255,0,0,0.97)',       // red
                    1.0,  'rgba(127,0,0,1)'           // dark red
                ]
            },
            layout: { visibility: document.getElementById('toggle-landprice-heat')?.checked ? 'visible' : 'none' }
        }, 'landprice-layer');
    }

    // --- 将来推計人口 1kmメッシュ ダイバージングコロプレス (2050年/2020年比) ---
    if (!map.getSource('pop-mesh')) map.addSource('pop-mesh', { type: 'geojson', data: './tokyo_future_population.geojson' });
    if (!map.getLayer('pop-mesh-layer')) {
        // PTN_2020 > 0 の場合のみ比率を計算、0の場合は中立値1.0とする
        const ratioExpr = ['case',
            ['>', ['get', 'PTN_2020'], 0],
            ['/', ['to-number', ['get', 'PTN_2050']], ['to-number', ['get', 'PTN_2020']]],
            1.0
        ];
        map.addLayer({
            id: 'pop-mesh-layer', type: 'fill', source: 'pop-mesh',
            paint: {
                // ダイバージング：赤(減少) ↔ 白(変化なし) ↔ 青(増加)
                'fill-color': [
                    'interpolate', ['linear'], ratioExpr,
                    0.0,  '#67001f',   // -100%: 最深赤
                    0.5,  '#b2182b',   // -50%
                    0.7,  '#d6604d',   // -30%
                    0.85, '#f4a582',   // -15%
                    0.95, '#fddbc7',   // -5%
                    1.0,  '#f7f7f7',   // 変化なし（白）
                    1.05, '#d1e5f0',   // +5%
                    1.15, '#92c5de',   // +15%
                    1.3,  '#4393c3',   // +30%
                    1.5,  '#2166ac',   // +50%
                    2.0,  '#053061'    // +100%: 最深青
                ],
                'fill-opacity': 0.7,
                'fill-outline-color': 'rgba(100,100,100,0.3)'
            },
            layout: { visibility: document.getElementById('toggle-pop-mesh')?.checked ? 'visible' : 'none' }
        }, 'unclustered-point');
    }

    // --- 将来推計人口 1kmメッシュ 総人口数コロプレス (2025年) ---
    if (!map.getLayer('pop-mesh-total-layer')) {
        map.addLayer({
            id: 'pop-mesh-total-layer', type: 'fill', source: 'pop-mesh',
            paint: {
                // スクリーンショット準拠：黄(少) → 橙 → 赤(多) の6段階
                'fill-color': [
                    'step', ['to-number', ['get', 'PTN_2025']],
                    '#FFFF00',   // < 500: 黄
                    500,  '#FFD700',   // 500〜1000: 黄橙
                    1000, '#FFA500',   // 1000〜2500: 橙
                    2500, '#FF6600',   // 2500〜5000: 濃橙
                    5000, '#E83000',   // 5000〜10000: 赤橙
                    10000, '#B20000'   // 10000以上: 深赤
                ],
                'fill-opacity': 0.5,
                'fill-outline-color': 'rgba(100,100,100,0.3)'
            },
            layout: { visibility: document.getElementById('toggle-pop-mesh-total')?.checked ? 'visible' : 'none' }
        }, 'unclustered-point');
    }

    // --- 3D建物 ---
    if (!map.getLayer('3d-buildings')) {
        map.addLayer({
            id: '3d-buildings', source: 'composite', 'source-layer': 'building', filter: ['==', 'extrude', 'true'], type: 'fill-extrusion',
            paint: { 'fill-extrusion-color': '#aaa', 'fill-extrusion-opacity': 0.5, 'fill-extrusion-height': ['get', 'height'] },
            layout: { visibility: document.getElementById('toggle-3d')?.checked ? 'visible' : 'none' }
        });
    }

}

/**
 * 5b. 駅別乗降客数レイヤー（LineString → 中点Pointに変換して表示）
 */
async function setupStationLayer() {
    if (map.getSource('stations')) return;
    try {
        const response = await fetch('./station_passengers.geojson');
        const geojson = await response.json();

        // LineString の中点を Point に変換
        const pointFeatures = geojson.features
            .filter(f => f.geometry?.coordinates?.length > 0)
            .map(feat => {
                const coords = feat.geometry.coordinates;
                const mid = coords[Math.floor(coords.length / 2)];
                return { type: 'Feature', geometry: { type: 'Point', coordinates: mid }, properties: feat.properties };
            });

        // 同名駅の全路線を取得できるよう state に保存
        state.stationData = pointFeatures;

        map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: pointFeatures } });

        // 乗降客数に応じたサイズの円
        map.addLayer({
            id: 'stations-circle', type: 'circle', source: 'stations',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['to-number', ['get', 'S12_057']],
                    0, 3, 5000, 5, 20000, 7, 100000, 11, 500000, 16, 1500000, 22
                ],
                'circle-color': '#0ea5e9',
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#ffffff',
                'circle-opacity': 0.85
            },
            layout: { visibility: document.getElementById('toggle-stations')?.checked ? 'visible' : 'none' }
        });

        // 駅名ラベル（円の上側）
        map.addLayer({
            id: 'stations-label', type: 'symbol', source: 'stations',
            layout: {
                'text-field': ['concat', ['get', 'S12_001'], '\n', ['to-string', ['to-number', ['get', 'S12_057']]], '人/日'],
                'text-size': 10,
                'text-offset': [0, -1.5],
                'text-anchor': 'bottom',
                'text-allow-overlap': false,
                'visibility': document.getElementById('toggle-stations')?.checked ? 'visible' : 'none'
            },
            paint: { 'text-color': '#0369a1', 'text-halo-color': '#ffffff', 'text-halo-width': 2 }
        });

        // ホバー・クリックイベント
        map.on('mouseenter', 'stations-circle', () => { if (!state.isDrawingMode) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'stations-circle', () => { map.getCanvas().style.cursor = ''; });
        map.on('click', 'stations-circle', (e) => {
            if (e.features.length > 0) showStationPopup(e.features[0], e.lngLat);
        });
    } catch (err) { console.error('Station layer load error:', err); }
}

/**
 * 6. インタラクション
 */
function setupInteractions() {
    map.off('click');
    map.on('click', (e) => {
        // 市区町村選択モード中はそちらで処理
        if (state.isMunicipalityMode) { handleMunicipalityClick(e); return; }
        // 円選択モード中はそちらで処理
        if (state.isCircleMode) { handleCircleClick(e); return; }

        // 判定の優先順位：物件ピン > 地価 > 人口メッシュ > 用途地域

        // 1. 物件ピン
        const props = map.queryRenderedFeatures(e.point, { layers: ['unclustered-point'] });
        if (props.length > 0) { selectProperty(props[0].properties.id, e.lngLat); return; }

        // 2. 地価情報
        const land = map.queryRenderedFeatures(e.point, { layers: ['landprice-layer'] });
        if (land.length > 0) { showAnalysisPopup(land[0], e.lngLat); return; }

        // 3. 人口メッシュ（増減 or 総人口）
        const pop = map.queryRenderedFeatures(e.point, { layers: ['pop-mesh-layer', 'pop-mesh-total-layer'] });
        if (pop.length > 0) { showPopulationPopup(pop[0], e.lngLat); return; }

        // 4. 用途地域
        const zoning = map.queryRenderedFeatures(e.point, { layers: ['zoning-layer'] });
        if (zoning.length > 0) { showAnalysisPopup(zoning[0], e.lngLat); return; }
    });

    // 円プレビュー用マウスムーブ
    map.on('mousemove', (e) => {
        if (!state.isCircleMode || !state.circleCenter) return;
        const radiusKm = turf.distance(turf.point(state.circleCenter), turf.point([e.lngLat.lng, e.lngLat.lat]), { units: 'kilometers' });
        if (radiusKm < 0.001) return;
        const circle = turf.circle(state.circleCenter, radiusKm, { steps: 64, units: 'kilometers' });
        map.getSource('circle-select').setData({ type: 'FeatureCollection', features: [circle] });
        const radiusM = Math.round(radiusKm * 1000);
        showRadiusLabel(e.point, radiusM >= 1000 ? `半径 ${radiusKm.toFixed(2)}km` : `半径 ${radiusM}m`);
    });

    // ホバー時のカーソル変更
    const hoverLayers = ['unclustered-point', 'landprice-layer', 'pop-mesh-layer', 'pop-mesh-total-layer', 'zoning-layer'];
    hoverLayers.forEach(l => {
        map.on('mouseenter', l, () => { if(!state.isDrawingMode && !state.isCircleMode) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', l, () => { if(!state.isCircleMode) map.getCanvas().style.cursor = ''; });
    });

    // 円選択レイヤーを初期化（スタイル変更後も再作成）
    ensureCircleLayers();
    if (state.circlePolygon) {
        map.getSource('circle-select').setData({ type: 'FeatureCollection', features: [state.circlePolygon] });
    }
}


/**
 * 7. ポップアップ表示（グラフ機能付き）
 */
function showAnalysisPopup(f, lngLat) {
    closeAllPopups(false);
    const p = f.properties;
    let html = "";

    if (f.layer.id === 'landprice-layer') {
        const subNo = parseInt(p.L01_005);
        const pointNo = parseInt(p.L01_006);
        const landNo = subNo > 0 ? `${p.L01_024}${subNo}-${pointNo}` : `${p.L01_024}-${pointNo}`;
        const year = p.L01_007 ? `${p.L01_007}年` : '不明';
        const price = p.L01_008 ? parseInt(p.L01_008).toLocaleString() + "円/㎡" : "不明";
        const location = p.L01_025 || '不明';
        const residence = (p.L01_026 && p.L01_026 !== '_') ? `<div style="font-size:10px; color:#888; margin-top:2px;">住居表示: ${p.L01_026}</div>` : '';
        const area = p.L01_027 ? `${parseInt(p.L01_027).toLocaleString()}㎡` : '不明';
        html = `
            <div class="analysis-popup" style="min-width:300px;">
                <div style="font-size:14px; font-weight:bold; color:#d97706; margin-bottom:8px;">📍 ${landNo}</div>
                <table style="width:100%; font-size:12px; border-collapse:collapse; margin-bottom:8px;">
                    <tr>
                        <th style="text-align:left; padding:4px 6px; background:#fef3c7; border:1px solid #fde68a; width:55px; white-space:nowrap;">調査年</th>
                        <td style="padding:4px 6px; border:1px solid #fde68a;">${year}</td>
                    </tr>
                    <tr>
                        <th style="text-align:left; padding:4px 6px; background:#fef3c7; border:1px solid #fde68a; white-space:nowrap;">所在</th>
                        <td style="padding:4px 6px; border:1px solid #fde68a;">${location}${residence}</td>
                    </tr>
                    <tr>
                        <th style="text-align:left; padding:4px 6px; background:#fef3c7; border:1px solid #fde68a; white-space:nowrap;">価格</th>
                        <td style="padding:4px 6px; border:1px solid #fde68a; font-weight:bold; color:#d97706;">${price}</td>
                    </tr>
                    <tr>
                        <th style="text-align:left; padding:4px 6px; background:#fef3c7; border:1px solid #fde68a; white-space:nowrap;">地積</th>
                        <td style="padding:4px 6px; border:1px solid #fde68a;">${area}</td>
                    </tr>
                </table>
                <div style="font-size:11px; font-weight:bold; margin-bottom:5px;">直近5年間の推移</div>
                <div style="height:140px;">
                    <canvas id="landTrendChart"></canvas>
                </div>
            </div>
        `;
    } else {
        const typeName = ZONING_TYPE_MAP[p.A29_004] || 'その他';
        html = `<div class="analysis-popup"><strong>用途地域情報</strong><br><b style="color:#E60012;">${typeName}</b><br>建ぺい率: ${p.A29_006}% / 容積率: ${p.A29_007}%</div>`;
    }

    state.currentPopup = new mapboxgl.Popup().setLngLat(lngLat).setHTML(html).setMaxWidth("none").addTo(map);

    // グラフ描画（地価の場合のみ）
    if (f.layer.id === 'landprice-layer') {
        setTimeout(() => {
            const ctx = document.getElementById('landTrendChart');
            if (ctx) {
                // L01_101(2022) から L01_105(2026) までのデータを配列化
                const trendData = [
                    p.L01_101, // 2022
                    p.L01_102, // 2023
                    p.L01_103, // 2024
                    p.L01_104, // 2025
                    p.L01_105  // 2026
                ];
                renderTrendChart(ctx, trendData);
            }
        }, 100);
    }
}

/**
 * Chart.js 描画関数
 */
function renderTrendChart(canvas, data) {
    new Chart(canvas, {
        type: 'line',
        data: {
            labels: ['2022', '2023', '2024', '2025', '2026'],
            datasets: [{
                label: '円/㎡',
                data: data,
                borderColor: '#d97706',
                backgroundColor: 'rgba(217, 119, 6, 0.1)',
                fill: true,
                tension: 0.3,
                borderWidth: 2,
                pointRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { ticks: { font: { size: 9 }, callback: (v) => v / 10000 + '万' } },
                x: { ticks: { font: { size: 10 } } }
            },
            plugins: { legend: { display: false } }
        }
    });
}

/**
 * 路線名から「N号線」プレフィックスを除去
 */
function cleanLineName(name) {
    if (!name) return name;
    // "N号線路線名" → "路線名"、"N号線(路線名)" → "路線名"
    let cleaned = name.replace(/^\d+号線/, '').replace(/^\((.+)\)$/, '$1');
    return cleaned || name;
}

/**
 * 駅別乗降客数ポップアップ
 */
function showStationPopup(f, lngLat) {
    closeAllPopups(false);
    const p = f.properties;
    const name     = p.S12_001 || '不明';
    const operator = p.S12_002 || '不明';
    const line     = cleanLineName(p.S12_003) || '不明';
    const latest   = p.S12_057 != null ? parseInt(p.S12_057).toLocaleString('ja-JP') : '不明';

    const html = `
        <div class="analysis-popup" style="min-width:240px;">
            <div style="font-size:14px; font-weight:bold; color:#0369a1; margin-bottom:8px;">🚉 ${name}</div>
            <table style="width:100%; font-size:12px; border-collapse:collapse;">
                <tr>
                    <th style="text-align:left; padding:4px 6px; background:#e0f2fe; border:1px solid #bae6fd; width:65px; white-space:nowrap;">事業者</th>
                    <td style="padding:4px 6px; border:1px solid #bae6fd;">${operator}</td>
                </tr>
                <tr>
                    <th style="text-align:left; padding:4px 6px; background:#e0f2fe; border:1px solid #bae6fd; white-space:nowrap;">路線</th>
                    <td style="padding:4px 6px; border:1px solid #bae6fd;">${line}</td>
                </tr>
                <tr>
                    <th style="text-align:left; padding:4px 6px; background:#e0f2fe; border:1px solid #bae6fd; white-space:nowrap;">乗降客数</th>
                    <td style="padding:4px 6px; border:1px solid #bae6fd; font-weight:bold; color:#0369a1;">${latest} 人/日</td>
                </tr>
            </table>
        </div>
    `;

    state.currentPopup = new mapboxgl.Popup()
        .setLngLat(lngLat)
        .setHTML(html)
        .setMaxWidth("none")
        .addTo(map);
}

function selectProperty(id, lngLat = null) {
    const feature = state.geoData.features.find(f => f.properties.id === id);
    if (!feature) return;
    const coords = lngLat || feature.geometry.coordinates;
    map.flyTo({ center: coords, zoom: 17 });

    // flyTo完了後にポップアップ全体が画面内に収まるよう自動調整
    map.once('moveend', () => {
        setTimeout(() => {
            const popupEl = state.currentPopup?.getElement();
            if (!popupEl) return;
            const popupRect = popupEl.getBoundingClientRect();
            const mapRect   = map.getContainer().getBoundingClientRect();
            const pad = 12;
            const dy = popupRect.top    < mapRect.top    + pad ? popupRect.top    - mapRect.top    - pad
                     : popupRect.bottom > mapRect.bottom - pad ? popupRect.bottom - mapRect.bottom + pad
                     : 0;
            const dx = popupRect.left   < mapRect.left   + pad ? popupRect.left   - mapRect.left   - pad
                     : popupRect.right  > mapRect.right  - pad ? popupRect.right  - mapRect.right  + pad
                     : 0;
            if (dx !== 0 || dy !== 0) map.panBy([dx, dy], { duration: 400 });
        }, 200);
    });

    closeAllPopups(true);
    const p = feature.properties;
    const isHotel = p.assetType === 'ホテル';
    const years = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
    const uid = Date.now();

    const fmt = v => (v != null && v !== '') ? v : '-';
    const fmtNum = v => (v != null && v !== '') ? Number(v).toLocaleString('ja-JP') : '-';
    const fmtYearMonth = v => {
        if (v == null || v === '') return '-';
        if (typeof v === 'number') {
            // Excel シリアル値 → 日付変換
            const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
            return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月`;
        }
        const s = String(v);
        const m = s.match(/(\d{4})[年\/\-](\d{1,2})/);
        if (m) return `${m[1]}年${parseInt(m[2])}月`;
        return s;
    };

    const getArr = prefix => years.map(y => { const v = p[`${prefix}${y}`]; return (v != null && v !== '') ? Number(v) : null; });
    const getLatest = prefix => { for (let y = 2026; y >= 2020; y--) { const v = p[`${prefix}${y}`]; if (v != null && v !== '') return Number(v); } return null; };
    const toHref = url => {
        const s = String(url).trim();
        if (/^https?:\/\//i.test(s)) return s;
        if (s.startsWith('\\\\')) return 'file:///' + s.replace(/\\/g, '/');
        if (/^[a-zA-Z]:\\/.test(s)) return 'file:///' + s.replace(/\\/g, '/');
        return s;
    };
    const linkBtn = (url, label) => (url && url !== '-' && String(url).trim() !== '')
        ? `<a href="${toHref(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:3px 10px;background:#2563eb;color:#fff;border-radius:4px;font-size:10px;text-decoration:none;margin-right:4px;">${label}</a>`
        : `<span style="display:inline-block;padding:3px 10px;background:#e5e7eb;color:#9ca3af;border-radius:4px;font-size:10px;margin-right:4px;">${label}: なし</span>`;

    const th = `style="background:#f3f4f6;text-align:left;padding:4px 6px;border:1px solid #e5e7eb;font-size:10px;white-space:nowrap;font-weight:600;"`;
    const td = `style="padding:4px 6px;border:1px solid #e5e7eb;font-size:10px;"`;

    const latestYield = getLatest('利回り');
    const commonRows = [
        ['物件ID',    fmt(p['物件ID'])],
        ['契約番号',  fmt(p['契約番号'])],
        ['物件所在地',fmt(p.address)],
        ['アセットタイプ', fmt(p.assetType)],
        ['契約形態',  fmt(p['契約形態'])],
        ['竣工年月',  fmtYearMonth(p['竣工年月'])],
        ['階数',      fmt(p['階数'])],
        ['取得価格',  fmtNum(p['取得価格'])],
        ['鑑定評価額',fmtNum(p['鑑定評価額'])],
        ['最新利回り',latestYield != null ? (latestYield * 100).toFixed(1) + '%' : '-'],
    ].map(([k, v]) => `<tr><th ${th}>${k}</th><td ${td}>${v}</td></tr>`).join('');

    let specificRows = '';
    if (isHotel) {
        const occ = getLatest('OCC'), adr = getLatest('ADR'), revpar = getLatest('RevPAR');
        specificRows = [
            ['最新OCC',    occ    != null ? (occ * 100).toFixed(1) + '%'         : '-'],
            ['最新ADR',    adr    != null ? '¥' + adr.toLocaleString('ja-JP')    : '-'],
            ['最新RevPAR', revpar != null ? '¥' + revpar.toLocaleString('ja-JP') : '-'],
        ].map(([k, v]) => `<tr><th ${th}>${k}</th><td ${td}>${v}</td></tr>`).join('');
    } else {
        const occ = getLatest('稼働率'), rent = getLatest('募集賃料');
        specificRows = [
            ['最新稼働率',   occ  != null ? (occ * 100).toFixed(1) + '%' : '-'],
            ['最新募集賃料', rent != null ? fmtNum(rent)               : '-'],
        ].map(([k, v]) => `<tr><th ${th}>${k}</th><td ${td}>${v}</td></tr>`).join('');
    }

    const opsLabel = isHotel ? 'OCC(%) / ADR(円)' : '稼働率(%) / 募集賃料';
    const html = `
        <div style="min-width:340px;max-width:420px;padding:4px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <span style="font-size:14px;font-weight:bold;">${fmt(p.name)}</span>
                <span style="background:${getAssetColor(p.assetType)};color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;">${fmt(p.assetType)}</span>
            </div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">${commonRows}${specificRows}</table>
            <div style="margin-bottom:10px;display:flex;flex-wrap:wrap;gap:4px;">
                ${linkBtn(p['稟議'],    '📋 稟議')}
                ${linkBtn(p['フォルダ①'], '📁 フォルダ①')}
                ${linkBtn(p['フォルダ②'], '📁 フォルダ②')}
            </div>
            <div style="border-top:1px solid #e5e7eb;padding-top:8px;margin-bottom:4px;">
                <div style="font-size:10px;font-weight:600;color:#374151;margin-bottom:4px;">利回り (%)</div>
                <canvas id="prop-chart-yield-${uid}" height="100"></canvas>
            </div>
            <div style="padding-top:8px;margin-bottom:4px;">
                <div style="font-size:10px;font-weight:600;color:#374151;margin-bottom:4px;">${opsLabel}</div>
                <canvas id="prop-chart-ops-${uid}" height="110"></canvas>
            </div>
            ${isHotel ? `
            <div style="padding-top:8px;">
                <div style="font-size:10px;font-weight:600;color:#374151;margin-bottom:4px;">RevPAR(円)</div>
                <canvas id="prop-chart-revpar-${uid}" height="100"></canvas>
            </div>` : ''}
        </div>`;

    state.currentPopup = new mapboxgl.Popup({ className: 'property-popup', maxWidth: '440px' })
        .setLngLat(coords).setHTML(html).addTo(map);
    state.currentPopup.on('close', () => { document.querySelectorAll('.property-card').forEach(c => c.classList.remove('active-card')); });

    document.querySelectorAll('.property-card').forEach(c => c.classList.remove('active-card'));
    const card = document.getElementById(`card-${id}`);
    if (card) { card.classList.add('active-card'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }

    setTimeout(() => {
        // 小数(0.995)→%(99.5)に変換する配列取得ヘルパー
        const getArrPct = prefix => getArr(prefix).map(v => v != null ? v * 100 : null);

        const yieldCtx = document.getElementById(`prop-chart-yield-${uid}`);
        if (yieldCtx) {
            new Chart(yieldCtx, {
                type: 'line',
                data: {
                    labels: years.map(String),
                    datasets: [{ label: '利回り(%)', data: getArrPct('利回り'), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)', tension: 0.3, fill: true, spanGaps: true, pointRadius: 3 }]
                },
                options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => v.toFixed(1) + '%', font: { size: 9 } } }, x: { ticks: { font: { size: 9 } } } } }
            });
        }

        const opsCtx = document.getElementById(`prop-chart-ops-${uid}`);
        if (opsCtx) {
            if (isHotel) {
                new Chart(opsCtx, {
                    type: 'line',
                    data: {
                        labels: years.map(String),
                        datasets: [
                            { label: 'OCC(%)',  data: getArrPct('OCC'), borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.06)', tension: 0.3, spanGaps: true, yAxisID: 'y',  pointRadius: 3 },
                            { label: 'ADR(円)', data: getArr('ADR'),    borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.06)', tension: 0.3, spanGaps: true, yAxisID: 'y2', pointRadius: 3 },
                        ]
                    },
                    options: {
                        responsive: true,
                        interaction: { mode: 'index', intersect: false },
                        plugins: { legend: { labels: { font: { size: 8 }, boxWidth: 10 } } },
                        scales: {
                            y:  { position: 'left',  ticks: { callback: v => v.toFixed(1) + '%', font: { size: 8 } } },
                            y2: { position: 'right', ticks: { callback: v => '¥' + Number(v).toLocaleString(), font: { size: 8 } }, grid: { drawOnChartArea: false } },
                            x:  { ticks: { font: { size: 8 } } }
                        }
                    }
                });

                const revparCtx = document.getElementById(`prop-chart-revpar-${uid}`);
                if (revparCtx) {
                    new Chart(revparCtx, {
                        type: 'line',
                        data: {
                            labels: years.map(String),
                            datasets: [{ label: 'RevPAR(円)', data: getArr('RevPAR'), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.08)', tension: 0.3, fill: true, spanGaps: true, pointRadius: 3 }]
                        },
                        options: {
                            responsive: true,
                            plugins: { legend: { display: false } },
                            scales: {
                                y: { ticks: { callback: v => '¥' + Number(v).toLocaleString(), font: { size: 8 } } },
                                x: { ticks: { font: { size: 8 } } }
                            }
                        }
                    });
                }
            } else {
                new Chart(opsCtx, {
                    type: 'line',
                    data: {
                        labels: years.map(String),
                        datasets: [
                            { label: '稼働率(%)',  data: getArrPct('稼働率'),  borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.06)', tension: 0.3, spanGaps: true, yAxisID: 'y',  pointRadius: 3 },
                            { label: '募集賃料',   data: getArr('募集賃料'), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.06)', tension: 0.3, spanGaps: true, yAxisID: 'y2', pointRadius: 3 },
                        ]
                    },
                    options: {
                        responsive: true,
                        interaction: { mode: 'index', intersect: false },
                        plugins: { legend: { labels: { font: { size: 8 }, boxWidth: 10 } } },
                        scales: {
                            y:  { position: 'left',  ticks: { callback: v => v.toFixed(1) + '%', font: { size: 8 } } },
                            y2: { position: 'right', ticks: { font: { size: 8 } }, grid: { drawOnChartArea: false } },
                            x:  { ticks: { font: { size: 8 } } }
                        }
                    }
                });
            }
        }
    }, 150);
}

function applyFilters() {
    const kw = document.getElementById('keyword-search').value.toLowerCase();
    const assetVal = document.getElementById('filter-asset').value;
    const contractVal = document.getElementById('filter-contract')?.value || 'all';
    const yieldMin = parseFloat(document.getElementById('yield-min')?.value ?? 0);
    const yieldMax = parseFloat(document.getElementById('yield-max')?.value ?? 20);
    const completionMin = parseInt(document.getElementById('completion-min')?.value ?? 1950);
    const completionMax = parseInt(document.getElementById('completion-max')?.value ?? 2030);
    const drawnData = draw.getAll();
    const drawPolygon = drawnData.features.length > 0 ? drawnData.features[0] : null;
    const activePolygon = drawPolygon || state.circlePolygon;

    const filtered = state.geoData.features.filter(f => {
        const p = f.properties;
        const matchKw = !kw || ((p['契約番号'] || '') + p.name + p.address).toLowerCase().includes(kw);
        const matchAsset = assetVal === 'all' || p.assetType === assetVal;
        const matchContract = contractVal === 'all' || p['契約形態'] === contractVal;

        // 最新利回り（小数→%換算してスライダーと比較）
        let matchYield = true;
        let latestYield = null;
        for (let y = 2026; y >= 2020; y--) {
            const v = p[`利回り${y}`];
            if (v != null && v !== '') { latestYield = Number(v) * 100; break; }
        }
        if (latestYield !== null) matchYield = latestYield >= yieldMin && latestYield <= yieldMax;

        let matchCompletion = true;
        const completionYear = getCompletionYear(p['竣工年月']);
        if (completionYear !== null) matchCompletion = completionYear >= completionMin && completionYear <= completionMax;

        let matchArea = true;
        if (activePolygon) matchArea = turf.booleanPointInPolygon(f.geometry, activePolygon);
        let matchMunicipality = true;
        if (state.municipalityPolygons) {
            matchMunicipality = state.municipalityPolygons.some(poly =>
                turf.booleanPointInPolygon(f.geometry, poly)
            );
        }
        return matchKw && matchAsset && matchContract && matchYield && matchCompletion && matchArea && matchMunicipality;
    });

    state.currentFilteredData = filtered;
    // チェックボックスをフィルタ結果で初期化（全選択）
    state.checkedIds = new Set(filtered.map(f => f.properties.id));

    document.getElementById('count-display').innerText = filtered.length;
    if (map.getSource('buildings')) map.getSource('buildings').setData({ type: 'FeatureCollection', features: filtered });

    const list = document.getElementById('listing');
    list.innerHTML = '';
    filtered.forEach(f => {
        const p = f.properties;
        const el = document.createElement('div');
        el.className = 'property-card';
        el.id = `card-${p.id}`;
        el.style.cssText = 'display:flex; align-items:flex-start; gap:6px;';

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = true;
        chk.title = '地図表示';
        chk.style.cssText = 'margin-top:3px; flex-shrink:0; cursor:pointer;';
        chk.onclick = e => e.stopPropagation();
        chk.onchange = () => {
            if (chk.checked) state.checkedIds.add(p.id);
            else state.checkedIds.delete(p.id);
            updateMapFromChecked();
        };

        const icon = iconMap[p.assetType] || '🏢';
        const badgeClass = BADGE_CLASSES[p.assetType] || 'badge-gray';

        const info = document.createElement('div');
        info.style.cssText = 'flex:1; min-width:0; cursor:pointer;';
        info.innerHTML = `
            <div style="font-weight:600; font-size:13px; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.name}</div>
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:2px;">
                <span class="badge ${badgeClass}" style="font-size:9px; padding:1px 6px; white-space:nowrap;">${icon} ${p.assetType}</span>
                ${p['契約形態'] ? `<span style="font-size:10px; color:#374151; white-space:nowrap;">契約形態：${p['契約形態']}</span>` : ''}
            </div>
            <div style="font-size:10px; color:#6b7280; margin-bottom:1px;">${p['契約番号'] ? `契約番号：${p['契約番号']}` : ''}</div>
            <div style="font-size:10px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.address ? `物件所在地：${p.address}` : ''}</div>`;
        info.onclick = () => selectProperty(p.id);

        el.appendChild(chk);
        el.appendChild(info);
        list.appendChild(el);
    });
}

function updateMapFromChecked() {
    const visible = state.currentFilteredData.filter(f => state.checkedIds.has(f.properties.id));
    if (map.getSource('buildings')) map.getSource('buildings').setData({ type: 'FeatureCollection', features: visible });
}

function getCompletionYear(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
        const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
        return d.getUTCFullYear();
    }
    const m = String(v).match(/(\d{4})/);
    return m ? parseInt(m[1]) : null;
}

function toggleCompletionSlider() {
    const area = document.getElementById('completion-slider-area');
    const arrow = document.getElementById('completion-toggle-arrow');
    if (!area) return;
    const open = area.style.display === 'none';
    area.style.display = open ? 'block' : 'none';
    if (arrow) arrow.textContent = open ? '▼' : '▶';
    if (open) onCompletionSlider();
}

function onCompletionSlider() {
    const minEl = document.getElementById('completion-min');
    const maxEl = document.getElementById('completion-max');
    let minVal = parseInt(minEl.value);
    let maxVal = parseInt(maxEl.value);
    if (minVal > maxVal) { minEl.value = maxVal; minVal = maxVal; }
    if (maxVal < minVal) { maxEl.value = minVal; maxVal = minVal; }

    const rangeMin = 1950, rangeMax = 2030, range = rangeMax - rangeMin;
    const minPct = (minVal - rangeMin) / range * 100;
    const maxPct = (maxVal - rangeMin) / range * 100;

    const fill = document.getElementById('completion-track-fill');
    if (fill) { fill.style.left = minPct + '%'; fill.style.width = (maxPct - minPct) + '%'; }

    const thumbSize = 16;
    const minTip = document.getElementById('completion-min-tip');
    const maxTip = document.getElementById('completion-max-tip');
    if (minTip) {
        const pct = (minVal - rangeMin) / range;
        minTip.style.left = `calc(${pct * 100}% + ${(0.5 - pct) * thumbSize}px)`;
        minTip.textContent = minVal + '年';
    }
    if (maxTip) {
        const pct = (maxVal - rangeMin) / range;
        maxTip.style.left = `calc(${pct * 100}% + ${(0.5 - pct) * thumbSize}px)`;
        maxTip.textContent = maxVal + '年';
    }

    const rangeLabel = document.getElementById('completion-range-label');
    if (rangeLabel) {
        rangeLabel.textContent = (minVal === 1950 && maxVal === 2030) ? '' : `${minVal}年〜${maxVal}年`;
    }

    applyFilters();
}

function resetYieldSlider() {
    const yMin = document.getElementById('yield-min');
    const yMax = document.getElementById('yield-max');
    if (yMin) yMin.value = 0;
    if (yMax) yMax.value = 20;
    onYieldSlider();
}

function resetCompletionSlider() {
    const cMin = document.getElementById('completion-min');
    const cMax = document.getElementById('completion-max');
    if (cMin) cMin.value = 1950;
    if (cMax) cMax.value = 2030;
    onCompletionSlider();
}

function toggleYieldSlider() {
    const area = document.getElementById('yield-slider-area');
    const arrow = document.getElementById('yield-toggle-arrow');
    if (!area) return;
    const open = area.style.display === 'none';
    area.style.display = open ? 'block' : 'none';
    if (arrow) arrow.textContent = open ? '▼' : '▶';
    if (open) onYieldSlider(); // トラック・ツールチップ初期描画
}

function onYieldSlider() {
    const minEl = document.getElementById('yield-min');
    const maxEl = document.getElementById('yield-max');
    let minVal = parseFloat(minEl.value);
    let maxVal = parseFloat(maxEl.value);
    // 交差しないよう補正
    if (minVal > maxVal) { minEl.value = maxVal; minVal = maxVal; }
    if (maxVal < minVal) { maxEl.value = minVal; maxVal = minVal; }

    const rangeMax = 20;
    const minPct = minVal / rangeMax * 100;
    const maxPct = maxVal / rangeMax * 100;

    // トラック塗り
    const fill = document.getElementById('yield-track-fill');
    if (fill) { fill.style.left = minPct + '%'; fill.style.width = (maxPct - minPct) + '%'; }

    // ツールチップ位置
    const thumbSize = 16;
    const minTip = document.getElementById('yield-min-tip');
    const maxTip = document.getElementById('yield-max-tip');
    if (minTip) {
        const pct = minVal / rangeMax;
        minTip.style.left = `calc(${pct * 100}% + ${(0.5 - pct) * thumbSize}px)`;
        minTip.textContent = minVal.toFixed(1) + '%';
    }
    if (maxTip) {
        const pct = maxVal / rangeMax;
        maxTip.style.left = `calc(${pct * 100}% + ${(0.5 - pct) * thumbSize}px)`;
        maxTip.textContent = maxVal.toFixed(1) + '%';
    }

    // 利回りラベル更新（閉じていても範囲を表示）
    const rangeLabel = document.getElementById('yield-range-label');
    if (rangeLabel) {
        rangeLabel.textContent = (minVal === 0 && maxVal === 20) ? '' : `${minVal.toFixed(1)}%〜${maxVal.toFixed(1)}%`;
    }

    applyFilters();
}

function populateContractFilter() {
    const sel = document.getElementById('filter-contract');
    if (!sel) return;
    const types = [...new Set(
        state.geoData.features.map(f => f.properties['契約形態']).filter(v => v != null && v !== '')
    )].sort();
    // 既存オプション（"全て"）を残して追加
    sel.innerHTML = '<option value="all">契約形態: 全て</option>' +
        types.map(t => `<option value="${t}">${t}</option>`).join('');
}

function clearFilters() {
    document.getElementById('keyword-search').value = '';
    document.getElementById('filter-asset').value = 'all';
    const contractSel = document.getElementById('filter-contract');
    if (contractSel) contractSel.value = 'all';
    const yMin = document.getElementById('yield-min');
    const yMax = document.getElementById('yield-max');
    if (yMin) yMin.value = 0;
    if (yMax) yMax.value = 20;
    // 利回りスライダーリセット
    const area = document.getElementById('yield-slider-area');
    const arrow = document.getElementById('yield-toggle-arrow');
    const label = document.getElementById('yield-range-label');
    if (area) area.style.display = 'none';
    if (arrow) arrow.textContent = '▶';
    if (label) label.textContent = '';
    onYieldSlider();

    // 竣工年月スライダーリセット
    const cMin = document.getElementById('completion-min');
    const cMax = document.getElementById('completion-max');
    if (cMin) cMin.value = 1950;
    if (cMax) cMax.value = 2030;
    const cArea = document.getElementById('completion-slider-area');
    const cArrow = document.getElementById('completion-toggle-arrow');
    const cLabel = document.getElementById('completion-range-label');
    if (cArea) cArea.style.display = 'none';
    if (cArrow) cArrow.textContent = '▶';
    if (cLabel) cLabel.textContent = '';
    onCompletionSlider();
}

function toggleTerrain() {
    const cb = document.getElementById('toggle-terrain');
    if (cb.checked) {
        if (!map.getSource('mapbox-dem')) {
            map.addSource('mapbox-dem', {
                type: 'raster-dem',
                url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
                tileSize: 512,
                maxzoom: 14
            });
        }
        map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
    } else {
        map.setTerrain(null);
    }
}

function toggleLayer(id) {
    // IDをチェックボックスのIDに変換
    let cbId = 'toggle-' + id.replace('-layer', '').replace('3d-buildings', '3d');
    
    // 特殊なID（pop-mesh-layer, landprice-heat）の例外処理
    if (id === 'pop-mesh-layer') cbId = 'toggle-pop-mesh';
    if (id === 'pop-mesh-total-layer') cbId = 'toggle-pop-mesh-total';
    if (id === 'landprice-heat') cbId = 'toggle-landprice-heat';
    if (id === 'stations-circle') cbId = 'toggle-stations';

    const cb = document.getElementById(cbId);
    if (map.getLayer(id) && cb) {
        const visibility = cb.checked ? 'visible' : 'none';
        map.setLayoutProperty(id, 'visibility', visibility);

        // 連動レイヤーの切り替え
        if (id === 'landprice-layer' && map.getLayer('landprice-label')) {
            map.setLayoutProperty('landprice-label', 'visibility', visibility);
        }
        if (id === 'stations-circle' && map.getLayer('stations-label')) {
            map.setLayoutProperty('stations-label', 'visibility', visibility);
        }

        // チェックを外した時は関連ポップアップを閉じる
        if (visibility === 'none') closeAllPopups(false);
    }
}

function updateHazards() {
    const checkboxes = document.querySelectorAll('.hazard-chk');
    const legendPanel = document.getElementById('legend-panel');
    const legendContent = document.getElementById('legend-content');
    let anyVisible = false;
    let html = "";

    checkboxes.forEach(chk => {
        const lid = chk.getAttribute('data-layer');
        if(!HAZARD_CONFIG[lid]) return;
        if(!map.getSource(lid)) {
            map.addSource(lid, { type: 'raster', tiles: [HAZARD_CONFIG[lid].url], tileSize: 256 });
            map.addLayer({ id: lid, type: 'raster', source: lid, paint: { 'raster-opacity': 0.7 }, layout: { visibility: 'none' } }, 'unclustered-point');
        }
        const visible = chk.checked;
        map.setLayoutProperty(lid, 'visibility', visible ? 'visible' : 'none');
        if(visible) { anyVisible = true; html += `<div class="mb-2 text-[10px]"><b>${HAZARD_CONFIG[lid].name}</b><img src="${HAZARD_CONFIG[lid].legend}" style="width:100%;"></div>`; }
    });
    if(legendPanel && legendContent) { legendPanel.style.display = anyVisible ? 'block' : 'none'; legendContent.innerHTML = html; }
}

/* ==========================================================
 * 不動産情報ライブラリ API 連携
 * proxy.js を起動した状態（node proxy.js）で使用してください。
 * ========================================================== */

/**
 * 地図の現在中心から都道府県コードを推定する
 */
function getPrefectureCode() {
    const { lng, lat } = map.getCenter();
    if (lat >= 35.48 && lat <= 35.9  && lng >= 138.9 && lng <= 140.0) return '13'; // 東京
    if (lat >= 34.3  && lat <= 35.0  && lng >= 135.0 && lng <= 135.8) return '27'; // 大阪
    if (lat >= 34.8  && lat <= 35.3  && lng >= 136.5 && lng <= 137.2) return '23'; // 愛知
    if (lat >= 35.0  && lat <= 35.6  && lng >= 139.2 && lng <= 139.8) return '14'; // 神奈川
    if (lat >= 35.7  && lat <= 36.3  && lng >= 139.3 && lng <= 139.9) return '11'; // 埼玉
    return '13'; // デフォルト: 東京
}

/**
 * プロキシ経由で REINFOLIB API を呼び出す
 */
async function fetchReinfolib(endpoint, params) {
    const url = new URL(`${REINFOLIB_BASE}/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`REINFOLIB API ${endpoint} error: ${res.status}`);
    const text = await res.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        console.error('[REINFOLIB] JSONパース失敗。レスポンス内容:', text.slice(0, 500));
        throw new Error('レスポンスがJSON形式ではありません');
    }
}

// ジオコーディング結果のキャッシュ（同一住所の重複API呼び出しを防ぐ）
const geocodeCache = {};

/**
 * 住所文字列をMapbox Geocoding APIで座標 [lng, lat] に変換する
 */
async function geocodeAddress(address) {
    if (address in geocodeCache) return geocodeCache[address];
    try {
        const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?country=jp&language=ja&limit=1&access_token=${mapboxgl.accessToken}`;
        const res = await fetch(url);
        const json = await res.json();
        geocodeCache[address] = (json.features && json.features.length > 0) ? json.features[0].center : null;
    } catch (e) {
        geocodeCache[address] = null;
    }
    return geocodeCache[address];
}

/**
 * APIレスポンスの配列を GeoJSON FeatureCollection に変換する
 * 座標フィールドがない場合は住所（Prefecture+Municipality+DistrictName）をジオコーディングして補完する
 * 同一地点の重複を避けるため、微小なランダムジッターを付与する
 */
async function toGeoJSON(data) {
    const latKeys = ['latitude', 'Latitude', 'lat', '緯度'];
    const lngKeys = ['longitude', 'Longitude', 'lng', '経度'];
    const hasCoords = d => latKeys.some(k => d[k]) && lngKeys.some(k => d[k]);

    // 座標フィールドがあればそのまま変換
    if (data.length > 0 && hasCoords(data[0])) {
        const features = data.filter(hasCoords).map(d => {
            const lat = parseFloat(latKeys.reduce((v, k) => v ?? d[k], null));
            const lng = parseFloat(lngKeys.reduce((v, k) => v ?? d[k], null));
            return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: d };
        });
        return { type: 'FeatureCollection', features };
    }

    // 座標なし → 住所からジオコーディング（ユニーク住所を最大500件、並列処理）
    const MAX_GEOCODE = 500;
    const uniqueAddresses = [...new Set(
        data.map(d => `${d.Prefecture || ''}${d.Municipality || ''}${d.DistrictName || ''}`)
    )].slice(0, MAX_GEOCODE);
    await Promise.all(uniqueAddresses.map(geocodeAddress));

    // 座標が取れたレコードのみ変換（表示上限10000件）
    const jitter = () => (Math.random() - 0.5) * 0.002;
    const features = data.slice(0, 10000).flatMap(d => {
        const address = `${d.Prefecture || ''}${d.Municipality || ''}${d.DistrictName || ''}`;
        const coords = geocodeCache[address];
        if (!coords) return [];
        // 同一地点に複数データが重なるのを防ぐため微小なジッターを付与
        return [{ type: 'Feature', geometry: { type: 'Point', coordinates: [coords[0] + jitter(), coords[1] + jitter()] }, properties: d }];
    });
    return { type: 'FeatureCollection', features };
}

/**
 * クラスタリング対応の GeoJSON ソース・レイヤーを追加する
 * - クラスター円: 件数バッジ付きの円。クリックするとズームインして展開
 * - 個別ピン: クラスターに含まれない単独のポイント。クリックでポップアップ表示
 */
function upsertClusteredLayer(sourceId, geojson, clusterColor, pointColor, onClickFn) {
    if (map.getSource(sourceId)) {
        map.getSource(sourceId).setData(geojson);
        return;
    }

    map.addSource(sourceId, {
        type: 'geojson', data: geojson,
        cluster: true, clusterMaxZoom: 15, clusterRadius: 50
    });

    // クラスター円（件数に応じてサイズが変化）
    map.addLayer({
        id: `${sourceId}-clusters`, type: 'circle', source: sourceId,
        filter: ['has', 'point_count'],
        paint: {
            'circle-color': clusterColor,
            'circle-radius': ['step', ['get', 'point_count'], 16, 10, 22, 50, 28, 100, 34],
            'circle-opacity': 0.85,
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff'
        }
    });

    // クラスター内の件数テキスト
    map.addLayer({
        id: `${sourceId}-cluster-count`, type: 'symbol', source: sourceId,
        filter: ['has', 'point_count'],
        layout: {
            'text-field': '{point_count_abbreviated}',
            'text-size': 12,
            'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Bold']
        },
        paint: { 'text-color': '#ffffff' }
    });

    // 個別ピン（クラスター未満の単独ポイント）
    map.addLayer({
        id: `${sourceId}-point`, type: 'circle', source: sourceId,
        filter: ['!', ['has', 'point_count']],
        paint: {
            'circle-radius': 6, 'circle-color': pointColor,
            'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff', 'circle-opacity': 0.9
        }
    });

    // クラスターをクリック → ズームインして展開
    map.on('click', `${sourceId}-clusters`, (e) => {
        const feature = map.queryRenderedFeatures(e.point, { layers: [`${sourceId}-clusters`] })[0];
        map.getSource(sourceId).getClusterExpansionZoom(feature.properties.cluster_id, (err, zoom) => {
            if (!err) map.easeTo({ center: feature.geometry.coordinates, zoom });
        });
    });

    // カーソル変更
    [`${sourceId}-clusters`, `${sourceId}-point`].forEach(id => {
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    });

    // 個別ピンをクリック → ポップアップ表示
    map.on('click', `${sourceId}-point`, (e) => {
        if (e.features.length > 0) onClickFn(e.features[0].properties, e.lngLat);
    });
}

/**
 * 鑑定評価書レイヤーのオン/オフ切替
 */
async function toggleAppraisalLayer() {
    const cb = document.getElementById('toggle-appraisal');
    if (!cb.checked) {
        ['appraisal-clusters', 'appraisal-cluster-count', 'appraisal-point'].forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource('appraisal')) map.removeSource('appraisal');
        closeAllPopups(false);
        return;
    }
    showToast('鑑定評価書データを取得・変換中...');
    const year = new Date().getFullYear() - 1;
    try {
        const json = await fetchReinfolib('XIT001', { year, area: REINFOLIB_TARGET_AREA });
        const geojson = await toGeoJSON(json.data || []);
        if (geojson.features.length === 0) {
            showToast('該当データが見つかりませんでした');
            cb.checked = false;
            return;
        }
        upsertClusteredLayer('appraisal', geojson, '#7c3aed', '#7c3aed', showAppraisalPopup);
        showToast(`鑑定評価書: ${geojson.features.length}件 表示しました`);
    } catch (err) {
        console.error('鑑定評価書 API error:', err);
        showToast(`取得に失敗しました (${err.message})`);
        cb.checked = false;
    }
}

/**
 * 鑑定評価書ポップアップ表示
 */
function showAppraisalPopup(p, lngLat) {
    closeAllPopups(false);
    const FIELDS = [
        { label: '1㎡当たりの価格',       keys: ['unitPrice', 'PricePerUnit', 'price_per_unit', '㎡単価', 'unit_price', '最新価格'] },
        { label: '相続税路線価',           keys: ['inheritanceTaxRoutePrice', '相続税路線価', 'inheritance_tax_route_price', 'routePrice'] },
        { label: '所在地番',               keys: ['lotNumber', 'lot_number', '所在地_所在地番', '所在地番', 'address_lot_number', 'location'] },
        { label: '住居表示',               keys: ['residentialAddress', 'residential_address', '所在地_住居表示', '住居表示'] },
        { label: '取引事例比較法比準価格', keys: ['comparisonMethodPrice', 'comparison_price', '比準価格', '取引事例比較法比準価格'] },
        { label: '公示価格',               keys: ['officialPrice', 'public_price', '公示価格', '公示価格を規準とした価格'] },
        { label: '変動率',                 keys: ['changeRate', 'change_rate', '変動率'] }
    ];
    const matched = FIELDS.map(({ label, keys }) => {
        const val = keys.reduce((found, k) => found ?? p[k], null);
        return (val != null && String(val) !== '') ? { label, val } : null;
    }).filter(Boolean);
    const skipKeys = new Set(['latitude', 'longitude', 'Latitude', 'Longitude']);
    const displayRows = matched.length > 0 ? matched : Object.entries(p)
        .filter(([k, v]) => !skipKeys.has(k) && v != null && v !== '')
        .map(([k, v]) => ({ label: k, val: v }));
    const fmtVal = v => {
        const n = Number(v);
        return (!isNaN(n) && String(v).trim() !== '') ? n.toLocaleString('ja-JP') : v;
    };
    const rows = displayRows.map(({ label, val }) => `
        <tr>
            <th style="text-align:left; padding:4px 6px; background:#f3e8ff; border:1px solid #d8b4fe; white-space:nowrap; font-size:11px;">${label}</th>
            <td style="padding:4px 6px; border:1px solid #d8b4fe; font-size:11px;">${fmtVal(val)}</td>
        </tr>`).join('');
    const html = `
        <div class="analysis-popup" style="min-width:300px; max-height:420px; overflow-y:auto;">
            <div style="font-size:14px; font-weight:bold; color:#7c3aed; margin-bottom:8px;">📋 鑑定評価書情報</div>
            <table style="width:100%; border-collapse:collapse;">${rows}</table>
        </div>`;
    state.currentPopup = new mapboxgl.Popup().setLngLat(lngLat).setHTML(html).setMaxWidth("none").addTo(map);
}

/**
 * 不動産取引価格レイヤーのオン/オフ切替
 */
async function toggleTransactionLayer() {
    const cb = document.getElementById('toggle-transaction');
    if (!cb.checked) {
        ['transaction-clusters', 'transaction-cluster-count', 'transaction-point'].forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        if (map.getSource('transaction')) map.removeSource('transaction');
        closeAllPopups(false);
        return;
    }
    showToast('取引価格データを取得中（全4四半期）...');
    const year = new Date().getFullYear() - 1;
    try {
        // 全4四半期を並列取得してマージ（取得失敗の四半期はスキップ）
        const results = await Promise.all(
            [1, 2, 3, 4].map(q =>
                fetchReinfolib('XIT001', { year, quarter: q, area: REINFOLIB_TARGET_AREA, response_division: 1 })
                    .catch(() => ({ data: [] }))
            )
        );
        const allData = results.flatMap(r => r.data || []);
        showToast(`ジオコーディング中... (${allData.length}件)`);
        const geojson = await toGeoJSON(allData);
        if (geojson.features.length === 0) {
            showToast('該当データが見つかりませんでした');
            cb.checked = false;
            return;
        }
        upsertClusteredLayer('transaction', geojson, '#22c55e', '#22c55e', showTransactionPopup);
        showToast(`取引価格: ${geojson.features.length}件 表示しました`);
    } catch (err) {
        console.error('取引価格 API error:', err);
        showToast(`取得に失敗しました (${err.message})`);
        cb.checked = false;
    }
}

// 取引価格 API レスポンスのキー → 日本語ラベル対応表
const TRANSACTION_LABEL_MAP = {
    Type: '種類', Region: '地域', MunicipalityCode: '市区町村コード',
    Prefecture: '都道府県', Municipality: '市区町村', DistrictName: '地区名',
    TradePrice: '取引価格（総額）', PricePerUnit: '坪単価', FloorPlan: '間取り',
    Area: '面積（㎡）', UnitPrice: '㎡単価', LandShape: '土地の形状',
    Frontage: '間口', TotalFloorArea: '延床面積', BuildingYear: '建築年',
    Structure: '建物の構造', Use: '用途', Purpose: '取引の目的',
    Direction: '前面道路方位', Classification: '前面道路の種類', Breadth: '前面道路幅員',
    CityPlanning: '都市計画', CoverageRatio: '建ぺい率', FloorAreaRatio: '容積率',
    Period: '取引時点', Renovation: '改装', Remarks: '備考'
};

/**
 * 不動産取引価格ポップアップ表示
 */
function showTransactionPopup(p, lngLat) {
    closeAllPopups(false);
    const fmtVal = v => {
        const n = Number(v);
        return (!isNaN(n) && String(v).trim() !== '') ? n.toLocaleString('ja-JP') : v;
    };
    const skipKeys = new Set(['latitude', 'longitude', 'Latitude', 'Longitude']);
    const rows = Object.entries(p)
        .filter(([k, v]) => !skipKeys.has(k) && v != null && v !== '')
        .map(([k, v]) => {
            const label = TRANSACTION_LABEL_MAP[k] || k;
            return `<tr>
                <th style="text-align:left; padding:4px 6px; background:#fef9c3; border:1px solid #fde047; white-space:nowrap; font-size:11px;">${label}</th>
                <td style="padding:4px 6px; border:1px solid #fde047; font-size:11px;">${fmtVal(v)}</td>
            </tr>`;
        }).join('');
    const html = `
        <div class="analysis-popup" style="min-width:300px; max-height:420px; overflow-y:auto;">
            <div style="font-size:14px; font-weight:bold; color:#b45309; margin-bottom:8px;">🏠 不動産取引価格情報</div>
            <table style="width:100%; border-collapse:collapse;">${rows}</table>
        </div>`;
    state.currentPopup = new mapboxgl.Popup().setLngLat(lngLat).setHTML(html).setMaxWidth("none").addTo(map);
}

/* ==========================================================
 * 円範囲選択
 * ========================================================== */

function ensureCircleLayers() {
    if (map.getSource('circle-select')) return;
    map.addSource('circle-select', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'circle-select-fill', type: 'fill', source: 'circle-select', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'circle-select-border', type: 'line', source: 'circle-select', paint: { 'line-color': '#3b82f6', 'line-width': 2, 'line-dasharray': [3, 2] } });
}

function toggleCircleMode() {
    const btn = document.getElementById('btn-circle-toggle');
    if (!state.isCircleMode && !state.circlePolygon) {
        // 他の選択モードを解除
        if (state.isDrawingMode) toggleDrawMode();
        if (state.isMunicipalityMode || state.municipalityPolygons) clearMunicipalityMode();
        state.isCircleMode = true;
        state.circleCenter = null;
        state.circlePolygon = null;
        ensureCircleLayers();
        map.getSource('circle-select').setData({ type: 'FeatureCollection', features: [] });
        map.getCanvas().style.cursor = 'crosshair';
        btn.innerHTML = '✖ 円選択中...';
        btn.classList.add('active-cancel');
        applyFilters();
    } else {
        clearCircleMode();
    }
}

function clearCircleMode() {
    state.isCircleMode = false;
    state.circleCenter = null;
    state.circlePolygon = null;
    map.getCanvas().style.cursor = '';
    const btn = document.getElementById('btn-circle-toggle');
    if (btn) { btn.innerHTML = '⭕ 円範囲選択'; btn.classList.remove('active-cancel', 'active'); }
    if (map.getSource('circle-select')) {
        map.getSource('circle-select').setData({ type: 'FeatureCollection', features: [] });
    }
    hideRadiusLabel();
    applyFilters();
}

function handleCircleClick(e) {
    const lngLat = [e.lngLat.lng, e.lngLat.lat];
    if (!state.circleCenter) {
        // 1クリック目: 中心点を設定
        state.circleCenter = lngLat;
    } else {
        // 2クリック目: 円を確定
        const radiusKm = turf.distance(turf.point(state.circleCenter), turf.point(lngLat), { units: 'kilometers' });
        if (radiusKm < 0.01) return; // 10m未満は無視
        const circle = turf.circle(state.circleCenter, radiusKm, { steps: 64, units: 'kilometers' });
        state.circlePolygon = circle;
        map.getSource('circle-select').setData({ type: 'FeatureCollection', features: [circle] });
        state.isCircleMode = false;
        state.circleCenter = null;
        map.getCanvas().style.cursor = '';
        hideRadiusLabel();
        const btn = document.getElementById('btn-circle-toggle');
        if (btn) { btn.innerHTML = '✖ 円選択解除'; btn.classList.remove('active-cancel'); btn.classList.add('active'); }
        applyFilters();
    }
}

function showRadiusLabel(point, text) {
    let label = document.getElementById('circle-radius-label');
    if (!label) {
        label = document.createElement('div');
        label.id = 'circle-radius-label';
        label.style.cssText = 'position:absolute; background:rgba(30,30,30,0.75); color:#fff; font-size:12px; font-weight:bold; padding:3px 9px; border-radius:4px; pointer-events:none; z-index:100; white-space:nowrap; box-shadow:0 1px 4px rgba(0,0,0,0.3);';
        document.getElementById('map').appendChild(label);
    }
    label.style.left = (point.x + 14) + 'px';
    label.style.top  = (point.y - 28) + 'px';
    label.style.display = 'block';
    label.textContent = text;
}

function hideRadiusLabel() {
    const label = document.getElementById('circle-radius-label');
    if (label) label.style.display = 'none';
}

/* ==========================================================
 * 市区町村選択
 * ========================================================== */

async function setupMunicipalityLayer() {
    if (map.getSource('municipalities')) return;
    try {
        if (!state._municipalityGeoJSON) {
            const response = await fetch('./tokyo_municipalities.geojson');
            state._municipalityGeoJSON = await response.json();
        }

        map.addSource('municipalities', { type: 'geojson', data: state._municipalityGeoJSON });

        // 通常の塗り（半透明）
        map.addLayer({
            id: 'municipality-fill', type: 'fill', source: 'municipalities',
            paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0 }
        }, 'unclustered-point');

        // 選択済み市区町村のハイライト
        map.addLayer({
            id: 'municipality-selected', type: 'fill', source: 'municipalities',
            filter: ['==', ['get', 'N03_004'], '__none__'],
            paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.2 }
        }, 'unclustered-point');

        // 境界線（常時表示）
        map.addLayer({
            id: 'municipality-border', type: 'line', source: 'municipalities',
            paint: { 'line-color': '#3b82f6', 'line-width': 1, 'line-opacity': 0 }
        });

        // ホバー用ハイライト
        map.addLayer({
            id: 'municipality-hover', type: 'fill', source: 'municipalities',
            filter: ['==', ['get', 'N03_004'], '__none__'],
            paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 }
        }, 'unclustered-point');

        map.on('mousemove', 'municipality-fill', (e) => {
            if (!state.isMunicipalityMode) return;
            const name = e.features[0]?.properties?.N03_004;
            if (name) map.setFilter('municipality-hover', ['==', ['get', 'N03_004'], name]);
        });
        map.on('mouseleave', 'municipality-fill', () => {
            map.setFilter('municipality-hover', ['==', ['get', 'N03_004'], '__none__']);
        });
    } catch (err) {
        console.error('Municipality layer load error:', err);
    }
}

function toggleMunicipalityMode() {
    const btn = document.getElementById('btn-municipality-toggle');
    if (!state.isMunicipalityMode && !state.municipalityPolygons) {
        // 他の選択モードを解除
        if (state.isDrawingMode) toggleDrawMode();
        if (state.isCircleMode || state.circlePolygon) clearCircleMode();
        state.isMunicipalityMode = true;
        map.getCanvas().style.cursor = 'pointer';
        if (btn) { btn.innerHTML = '✖ 市区町村を選択中...'; btn.classList.add('active-cancel'); }
        // 境界線を表示
        if (map.getLayer('municipality-border')) map.setPaintProperty('municipality-border', 'line-opacity', 0.5);
        if (map.getLayer('municipality-fill')) map.setPaintProperty('municipality-fill', 'fill-opacity', 0.01);
    } else {
        clearMunicipalityMode();
    }
}

function clearMunicipalityMode() {
    state.isMunicipalityMode = false;
    state.municipalityPolygons = null;
    state.municipalityName = null;
    map.getCanvas().style.cursor = '';
    const btn = document.getElementById('btn-municipality-toggle');
    if (btn) { btn.innerHTML = '🗾 市区町村選択'; btn.classList.remove('active-cancel', 'active'); }
    // レイヤーを非表示に戻す
    if (map.getLayer('municipality-border')) map.setPaintProperty('municipality-border', 'line-opacity', 0);
    if (map.getLayer('municipality-fill')) map.setPaintProperty('municipality-fill', 'fill-opacity', 0);
    if (map.getLayer('municipality-selected')) map.setFilter('municipality-selected', ['==', ['get', 'N03_004'], '__none__']);
    if (map.getLayer('municipality-hover')) map.setFilter('municipality-hover', ['==', ['get', 'N03_004'], '__none__']);
    applyFilters();
}

function handleMunicipalityClick(e) {
    if (!state._municipalityGeoJSON) return;
    const point = turf.point([e.lngLat.lng, e.lngLat.lat]);
    // クリック地点が含まれるN03_004を特定
    const hit = state._municipalityGeoJSON.features.find(f =>
        f.geometry && turf.booleanPointInPolygon(point, f)
    );
    if (!hit) return;
    const name = hit.properties.N03_004;
    if (!name) return;

    // 同じ市区町村の全フィーチャを取得
    const polygons = state._municipalityGeoJSON.features.filter(f => f.properties.N03_004 === name);
    state.municipalityPolygons = polygons;
    state.municipalityName = name;
    state.isMunicipalityMode = false;
    map.getCanvas().style.cursor = '';

    const btn = document.getElementById('btn-municipality-toggle');
    if (btn) { btn.innerHTML = `✖ ${name} (解除)`; btn.classList.remove('active-cancel'); btn.classList.add('active'); }

    // 選択した市区町村をハイライト
    if (map.getLayer('municipality-selected')) map.setFilter('municipality-selected', ['==', ['get', 'N03_004'], name]);
    if (map.getLayer('municipality-hover')) map.setFilter('municipality-hover', ['==', ['get', 'N03_004'], '__none__']);

    applyFilters();
}

function toggleDrawMode() {
    const btn = document.getElementById('btn-draw-toggle');
    const hasPolygon = draw.getAll().features.length > 0;

    if (!state.isDrawingMode && !hasPolygon) {
        // 描画開始
        if (state.isCircleMode || state.circlePolygon) clearCircleMode();
        if (state.isMunicipalityMode || state.municipalityPolygons) clearMunicipalityMode();
        draw.changeMode('draw_polygon');
        btn.innerHTML = '🗑️ 選択解除';
        btn.classList.add('active-cancel');
        btn.classList.remove('active');
        state.isDrawingMode = true;
    } else {
        // 描画中 or 確定済み → 解除
        draw.deleteAll();
        draw.changeMode('simple_select');
        btn.innerHTML = '📐 範囲選択';
        btn.classList.remove('active-cancel', 'active');
        state.isDrawingMode = false;
        applyFilters();
    }
}

function closeAllPopups(forceAll = false) {
    if (forceAll) {
        if (state.currentPopup) state.currentPopup.remove();
        document.querySelectorAll('.property-card').forEach(c => c.classList.remove('active-card'));
        const pops = document.getElementsByClassName('mapboxgl-popup');
        while (pops[0]) pops[0].remove();
    } else {
        Array.from(document.getElementsByClassName('mapboxgl-popup')).forEach(p => { if (!p.classList.contains('property-popup')) p.remove(); });
    }
}

function clearAllLayers() {
    document.querySelectorAll('input[type="checkbox"]').forEach(chk => chk.checked = false);
    ['zoning-layer', 'landprice-layer', 'landprice-label', 'landprice-heat', 'pop-mesh-layer', 'pop-mesh-total-layer', 'stations-circle', 'stations-label', '3d-buildings'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
    // REINFOLIB レイヤーはソースごと削除（チェックを外すだけでは残るため）
    ['appraisal-clusters', 'appraisal-cluster-count', 'appraisal-point'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource('appraisal')) map.removeSource('appraisal');
    ['transaction-clusters', 'transaction-cluster-count', 'transaction-point'].forEach(id => {
        if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource('transaction')) map.removeSource('transaction');
    map.setTerrain(null);
    clearCircleMode();
    clearMunicipalityMode();
    updateHazards();
    closeAllPopups(false);
}

function toggleLayerMenu() {
    const c = document.getElementById('layer-content');
    const label = document.getElementById('layer-header-text');
    if (!c) return;
    const isHidden = c.style.display === 'none' || c.style.display === '';
    c.style.display = isHidden ? 'block' : 'none';
    if (label) label.textContent = isHidden ? 'レイヤー設定非表示' : 'レイヤー設定表示';
}

/* ==========================================================
 * Excel 出力
 * ========================================================== */
function exportExcel() {
    const rows = state.currentFilteredData.filter(f => state.checkedIds.has(f.properties.id)).map(f => {
        const p = f.properties;
        return {
            'ID':              p.id          || '',
            '物件名':          p.name        || '',
            '住所':            p.address     || '',
            '最寄駅':          p.station     || '',
            'アセットタイプ':  p.assetType   || '',
            '取引形態':        p.dealType    || '',
            'Capレート(%)':    p.capRate     != null ? Number(p.capRate)     : '',
            '地価公示(万円/㎡)': p.landPrice != null ? Number(p.landPrice)   : '',
            '鑑定評価(億円)':  p.appraisal   != null ? Number(p.appraisal)   : '',
            '竣工年':          p.year        != null ? Number(p.year)        : '',
            '延床面積(㎡)':    p.gfa         != null ? Number(p.gfa)         : '',
        };
    });

    const ws = XLSX.utils.json_to_sheet(rows);

    // 列幅の自動調整
    const colWidths = Object.keys(rows[0] || {}).map(key => ({
        wch: Math.max(key.length * 2, 12)
    }));
    ws['!cols'] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '物件一覧');
    XLSX.writeFile(wb, `物件一覧_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

/* ==========================================================
 * リンク共有
 * ========================================================== */
function shareState() {
    const center = map.getCenter();
    const p = new URLSearchParams();
    p.set('lng',     center.lng.toFixed(6));
    p.set('lat',     center.lat.toFixed(6));
    p.set('zoom',    map.getZoom().toFixed(2));
    p.set('pitch',   map.getPitch().toFixed(1));
    p.set('bearing', map.getBearing().toFixed(1));

    const kw = document.getElementById('keyword-search')?.value;
    if (kw) p.set('kw', kw);

    const asset = document.getElementById('filter-asset')?.value;
    if (asset && asset !== 'all') p.set('asset', asset);

    const styleVal = document.getElementById('basemap-select')?.value;
    if (styleVal) p.set('style', styleVal);

    // オンになっているレイヤーチェックボックス
    const checkedLayers = [...document.querySelectorAll('#layer-content input[type="checkbox"]:not(.hazard-chk):checked')]
        .map(el => el.id.replace('toggle-', ''));
    if (checkedLayers.length) p.set('layers', checkedLayers.join(','));

    // ハザードチェックボックス
    const checkedHazards = [...document.querySelectorAll('.hazard-chk:checked')]
        .map(el => el.getAttribute('data-layer'));
    if (checkedHazards.length) p.set('hazards', checkedHazards.join(','));

    // 円選択
    if (state.circlePolygon) {
        const bbox = turf.bbox(state.circlePolygon);
        const clng = ((bbox[0] + bbox[2]) / 2).toFixed(6);
        const clat = ((bbox[1] + bbox[3]) / 2).toFixed(6);
        const r = turf.distance(
            turf.point([parseFloat(clng), parseFloat(clat)]),
            turf.point([bbox[2], parseFloat(clat)]),
            { units: 'kilometers' }
        ).toFixed(4);
        p.set('circle', `${clng},${clat},${r}`);
    }

    const url = `${location.origin}${location.pathname}?${p.toString()}`;
    navigator.clipboard.writeText(url)
        .then(() => showToast('🔗 リンクをクリップボードにコピーしました'))
        .catch(() => { window.prompt('以下のリンクをコピーしてください:', url); });
}

function showToast(msg) {
    let toast = document.getElementById('rei-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'rei-toast';
        toast.style.cssText = [
            'position:fixed', 'bottom:36px', 'left:50%', 'transform:translateX(-50%)',
            'background:rgba(15,23,42,0.88)', 'color:#fff', 'font-size:13px',
            'font-weight:bold', 'padding:10px 22px', 'border-radius:8px',
            'box-shadow:0 4px 14px rgba(0,0,0,0.25)', 'z-index:9999',
            'transition:opacity 0.4s', 'pointer-events:none', 'white-space:nowrap'
        ].join(';');
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

/* ==========================================================
 * PDF出力（稟議資料）
 * ========================================================== */
function exportPDF() {
    const mapImg = map.getCanvas().toDataURL('image/png');
    const date = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    const data = state.currentFilteredData.filter(f => state.checkedIds.has(f.properties.id));

    const count = data.length;
    const avgCap = count > 0
        ? (data.reduce((s, f) => s + parseFloat(f.properties.capRate || 0), 0) / count).toFixed(2)
        : '-';
    const avgLand = count > 0
        ? Math.round(data.reduce((s, f) => s + (f.properties.landPrice || 0), 0) / count).toLocaleString()
        : '-';

    const BADGE_COLOR = { 'オフィス': '#3b82f6', 'レジデンス': '#10b981', '商業施設': '#f59e0b', 'ホテル': '#ef4444', '物流施設': '#8b5cf6' };

    const rows = data.map((f, i) => {
        const p = f.properties;
        const color = BADGE_COLOR[p.assetType] || '#6b7280';
        return `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9fafb'}">
            <td>${p.id || '-'}</td>
            <td style="font-weight:600;">${p.name || '-'}</td>
            <td>${p.address || '-'}</td>
            <td><span style="background:${color};color:#fff;padding:1px 6px;border-radius:3px;font-size:10px;">${p.assetType || '-'}</span></td>
            <td>${p.dealType || '-'}</td>
            <td style="text-align:right;font-weight:600;">${p.capRate ? p.capRate + '%' : '-'}</td>
            <td style="text-align:right;">${p.landPrice ? Number(p.landPrice).toLocaleString() + '万円/㎡' : '-'}</td>
            <td style="text-align:right;">${p.appraisal ? p.appraisal + '億円' : '-'}</td>
            <td style="text-align:right;">${p.year ? p.year + '年' : '-'}</td>
            <td>${p.station || '-'}</td>
        </tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>不動産物件調査報告書 ${date}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", "Hiragino Kaku Gothic ProN", "Meiryo", sans-serif; font-size: 11px; color: #1f2937; background: #fff; }
  .page { width: 210mm; min-height: 297mm; padding: 14mm 14mm 10mm; margin: 0 auto; }
  /* ヘッダー */
  .header { border-bottom: 3px solid #1e3a5f; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; }
  .header-title { font-size: 22px; font-weight: 800; color: #1e3a5f; letter-spacing: 0.05em; }
  .header-sub { font-size: 11px; color: #6b7280; margin-top: 3px; }
  .header-right { text-align: right; font-size: 11px; color: #6b7280; line-height: 1.7; }
  /* サマリカード */
  .summary-grid { display: flex; gap: 10px; margin-bottom: 14px; }
  .summary-card { flex: 1; background: #f0f4ff; border-left: 4px solid #3b82f6; border-radius: 4px; padding: 8px 12px; }
  .summary-card .label { font-size: 10px; color: #6b7280; margin-bottom: 2px; }
  .summary-card .value { font-size: 20px; font-weight: 800; color: #1e3a5f; }
  .summary-card .unit  { font-size: 11px; color: #6b7280; margin-left: 2px; }
  /* 地図 */
  .map-section { margin-bottom: 14px; }
  .section-title { font-size: 12px; font-weight: 700; color: #1e3a5f; border-left: 3px solid #3b82f6; padding-left: 8px; margin-bottom: 6px; }
  .map-img { width: 100%; height: auto; border: 1px solid #e5e7eb; border-radius: 4px; display: block; }
  /* テーブル */
  .table-section { }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  thead tr { background: #1e3a5f; color: #fff; }
  thead th { padding: 6px 5px; text-align: left; font-weight: 600; white-space: nowrap; }
  tbody td { padding: 5px 5px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }
  /* フッター */
  .footer { margin-top: 14px; border-top: 1px solid #e5e7eb; padding-top: 8px; display: flex; justify-content: space-between; font-size: 10px; color: #9ca3af; }
  @media print {
    @page { size: A4 landscape; margin: 8mm; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .page { width: 100%; padding: 0; }
    .no-print { display: none !important; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div>
      <div class="header-title">不動産物件調査報告書</div>
      <div class="header-sub">REI-Map — 不動産情報統合検索プラットフォーム</div>
    </div>
    <div class="header-right">
      <div>作成日：${date}</div>
      <div>抽出件数：${count} 件</div>
    </div>
  </div>

  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">抽出物件数</div>
      <div class="value">${count}<span class="unit">件</span></div>
    </div>
    <div class="summary-card">
      <div class="label">平均 Cap レート</div>
      <div class="value">${avgCap}<span class="unit">%</span></div>
    </div>
    <div class="summary-card">
      <div class="label">平均地価公示</div>
      <div class="value">${avgLand}<span class="unit">万円/㎡</span></div>
    </div>
  </div>

  <div class="map-section">
    <div class="section-title">対象エリア地図</div>
    <img class="map-img" src="${mapImg}" alt="Map">
  </div>

  <div class="table-section">
    <div class="section-title">物件一覧</div>
    <table>
      <thead>
        <tr>
          <th>ID</th><th>物件名</th><th>住所</th><th>アセット</th><th>取引形態</th>
          <th>Cap率</th><th>地価公示</th><th>鑑定評価</th><th>竣工年</th><th>最寄駅</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="footer">
    <span>本資料は REI-Map より自動生成されました。内容は参考情報であり、投資判断の根拠とはなりません。</span>
    <span>${date}</span>
  </div>
</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'width=900,height=700');
    win.addEventListener('unload', () => URL.revokeObjectURL(url), { once: true });
}

function changeBaseMap() { map.setStyle(document.getElementById('basemap-select').value); }
function getAssetColor(t) { return { 'オフィス': '#3b82f6', 'レジデンス': '#10b981', '商業施設': '#f59e0b', 'ホテル': '#ef4444', '物流施設': '#8b5cf6' }[t] || '#6b7280'; }
function getSvgIcon(c, t) { const e = iconMap[t] || '🏢'; const s = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="${c}" stroke="white" stroke-width="2" /><text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" font-size="20">${e}</text></svg>`; return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s); }
function toggleKeywordClear() {
    const val = document.getElementById('keyword-search').value;
    const btn = document.getElementById('keyword-clear-btn');
    if (btn) btn.style.display = val ? 'block' : 'none';
}

function clearKeywordSearch() {
    const el = document.getElementById('keyword-search');
    const btn = document.getElementById('keyword-clear-btn');
    if (el) el.value = '';
    if (btn) btn.style.display = 'none';
    applyFilters();
}

function clearGeocoderSearch() {
    geocoder.clear();
    const btn = document.getElementById('geocoder-clear-btn');
    if (btn) btn.style.display = 'none';
}

function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    sb.classList.toggle('hidden');
    document.body.classList.toggle('list-open');
    const btn = document.getElementById('sidebar-toggle');
    if (btn) btn.innerText = sb.classList.contains('hidden') ? '一覧表示' : '一覧非表示';
}

map.on('style.load', async () => {
    await setupMapContent();
    await setupMunicipalityLayer();
    // ベースマップ切替後に選択済み市区町村のハイライトを復元
    if (state.municipalityName && map.getLayer('municipality-selected')) {
        map.setFilter('municipality-selected', ['==', ['get', 'N03_004'], state.municipalityName]);
        if (map.getLayer('municipality-border')) map.setPaintProperty('municipality-border', 'line-opacity', 0.5);
        if (map.getLayer('municipality-fill')) map.setPaintProperty('municipality-fill', 'fill-opacity', 0.01);
    }
    if (state.geoData.features.length > 0) applyFilters();
    // ベースマップ切替後にチェック済みのterrainを復元
    if (document.getElementById('toggle-terrain')?.checked) toggleTerrain();
});
map.on('load', () => { loadExcelData(); restoreMapPosition(); });

/**
 * 人口メッシュ専用のポップアップ表示
 */
function showPopulationPopup(f, lngLat) {
    closeAllPopups(false);
    const p = f.properties;

    const base = p.PTN_2020 || 0;
    const pop2025 = p.PTN_2025 || 0;
    const pop2050 = p.PTN_2050 || 0;
    const changeRate = base > 0 ? ((pop2050 / base - 1) * 100).toFixed(1) : null;
    const changeColor = changeRate === null ? '#666' : (parseFloat(changeRate) >= 0 ? '#2166ac' : '#b2182b');
    const changeLabel = changeRate === null ? '不明' : `${parseFloat(changeRate) >= 0 ? '+' : ''}${changeRate}%`;
    const isTotal = f.layer.id === 'pop-mesh-total-layer';
    const title = isTotal ? '将来推計人口（総人口数）' : '将来推計人口（増減）';

    const summaryHtml = isTotal ? `
        <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
            <div>
                <span style="font-size:10px; color:#666;">2025年推計</span><br>
                <b style="font-size:20px;">${Math.round(pop2025).toLocaleString()}</b> <span style="font-size:10px;">人</span>
            </div>
            <div style="text-align:right;">
                <span style="font-size:10px; color:#666;">2050年推計</span><br>
                <b style="font-size:16px;">${Math.round(pop2050).toLocaleString()}</b> <span style="font-size:10px;">人</span>
            </div>
        </div>` : `
        <div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">
            <div>
                <span style="font-size:10px; color:#666;">2020年（基準）</span><br>
                <b style="font-size:16px;">${Math.round(base).toLocaleString()}</b> <span style="font-size:10px;">人</span>
            </div>
            <div style="text-align:center;">
                <span style="font-size:10px; color:#666;">2050年推計</span><br>
                <b style="font-size:16px;">${Math.round(pop2050).toLocaleString()}</b> <span style="font-size:10px;">人</span>
            </div>
            <div style="text-align:right;">
                <span style="font-size:10px; color:#666;">2020年比</span><br>
                <b style="font-size:18px; color:${changeColor};">${changeLabel}</b>
            </div>
        </div>`;

    const html = `
        <div class="analysis-popup" style="min-width:280px;">
            <strong style="font-size:14px;">${title}</strong>
            ${summaryHtml}
            <hr style="margin:10px 0;">
            <div style="font-size:11px; font-weight:bold; margin-bottom:5px;">人口推移予測 (2020〜2050)</div>
            <div style="height:140px;">
                <canvas id="popTrendChart"></canvas>
            </div>
        </div>
    `;

    state.currentPopup = new mapboxgl.Popup()
        .setLngLat(lngLat)
        .setHTML(html)
        .setMaxWidth("none")
        .addTo(map);

    setTimeout(() => {
        const ctx = document.getElementById('popTrendChart');
        if (ctx) {
            const labels = ['2020', '2025', '2030', '2035', '2040', '2045', '2050'];
            const popData = [p.PTN_2020, p.PTN_2025, p.PTN_2030, p.PTN_2035, p.PTN_2040, p.PTN_2045, p.PTN_2050];
            renderPopulationChart(ctx, labels, popData, base);
        }
    }, 100);
}

/**
 * 人口グラフの描画 (Chart.js)
 */
function renderPopulationChart(canvas, labels, data, base) {
    // 各年の増減に応じてバーの色を変える（青=増加、赤=減少）
    const bgColors = data.map(v =>
        v === null || v === undefined ? 'rgba(180,180,180,0.5)'
        : v >= (base || 0) ? 'rgba(33,102,172,0.65)'
        : 'rgba(178,24,43,0.65)'
    );
    new Chart(canvas, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: '推計人口（人）',
                data: data,
                backgroundColor: bgColors,
                borderWidth: 0,
                borderRadius: 3
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, ticks: { font: { size: 9 } } },
                x: { ticks: { font: { size: 9 } } }
            },
            plugins: { legend: { display: false } }
        }
    });
}