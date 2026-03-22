/**
 * REI-Map メインアプリケーションロジック
 *
 * 主な機能:
 *  - MapLibre GL JS を使った地図表示・操作（ベースマップ切替、3D建物、地形）
 *  - buildingInfo.xlsx から物件データを読み込み、マップにピン表示
 *  - 物件の詳細ポップアップ表示（Chart.js による利回り・稼働率・RevPAR グラフ）
 *  - 範囲フィルタ（矩形描画 / 円選択 / 市区町村選択）
 *  - サイドバーによる物件一覧・フィルタ（アセット・契約形態・利回り・竣工年月）
 *  - レイヤー表示切替（用途地域・地価公示・将来人口・駅乗降客数・ハザードマップ）
 *  - Excel / PDF（プレビュー）出力、URL共有
 */

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
    checkedIds: new Set(),
    geocoderMarker: null
};

// 不動産情報ライブラリ API の取得対象エリア（都道府県コード）
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
    const styleKey = p.get('style');
    if (styleKey && styleKey !== 'style-light' && BASE_STYLES[styleKey]) {
        map.setStyle(BASE_STYLES[styleKey]);
    }
}

// ベースマップスタイルを取得
function getStyleUrl(key) {
    return BASE_STYLES[key] || BASE_STYLES['style-light'];
}

const map = new maplibregl.Map({
    container: 'map',
    style: getStyleUrl(document.getElementById('basemap-select')?.value || 'style-light'),
    center: [139.744, 35.688], // 千代田区中心付近
    zoom: 14.5,
    pitch: 50,
    preserveDrawingBuffer: true
});

// リセットビューコントロール
class ResetViewControl {
    onAdd(map) {
        this._map = map;
        this._container = document.createElement('div');
        this._container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
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
map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showZoom: false, showCompass: true }), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ showZoom: true, showCompass: false }), 'bottom-right');
map.addControl(new ResetViewControl(), 'bottom-right');

// ジオコーダー（MapTiler Geocoding API）
async function geocoderSearch() {
    const input = document.getElementById('geocoder-input');
    const query = input?.value?.trim();
    if (!query) return;

    try {
        const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${MAPTILER_KEY}&language=ja&country=jp&limit=1`;
        const res = await fetch(url);
        const json = await res.json();
        if (json.features && json.features.length > 0) {
            const [lon, lat] = json.features[0].center;
            const lngLat = [lon, lat];
            map.flyTo({ center: lngLat, zoom: 15, duration: 1500 });

            // マーカーを配置
            if (state.geocoderMarker) state.geocoderMarker.remove();
            state.geocoderMarker = new maplibregl.Marker({ color: '#3b82f6' })
                .setLngLat(lngLat)
                .addTo(map);

            const btn = document.getElementById('geocoder-clear-btn');
            if (btn) btn.style.display = 'block';
        } else {
            showToast('検索結果が見つかりませんでした');
        }
    } catch (e) {
        console.error('Geocoder error:', e);
        showToast('検索に失敗しました');
    }
}

function clearGeocoderSearch() {
    const input = document.getElementById('geocoder-input');
    if (input) input.value = '';
    if (state.geocoderMarker) { state.geocoderMarker.remove(); state.geocoderMarker = null; }
    const btn = document.getElementById('geocoder-clear-btn');
    if (btn) btn.style.display = 'none';
}

// 2. 描画コントロール（MapboxDraw は MapLibre 互換）
const draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: { polygon: false, trash: false },
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
    // スタイル変更後は全画像が消えるため、既存があれば削除してから再登録
    await Promise.all(state.assetTypes.map(type => {
        return new Promise(resolve => {
            const imgId = `icon-${type}`;
            const img = new Image();
            img.src = getSvgIcon(getAssetColor(type), type);
            img.onload = () => {
                try { if (map.hasImage(imgId)) map.removeImage(imgId); } catch(e) {}
                map.addImage(imgId, img);
                resolve();
            };
            img.onerror = () => resolve();
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
                'heatmap-weight': [
                    'interpolate', ['linear'], ['get', 'L01_008'],
                    0,        0,
                    500000,   0.05,
                    1000000,  0.15,
                    2000000,  0.35,
                    5000000,  0.65,
                    10000000, 0.85,
                    67100000, 1.0
                ],
                'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 9, 40, 12, 60, 15, 80],
                'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 12, 2.5, 15, 4],
                'heatmap-opacity': 0.75,
                'heatmap-color': [
                    'interpolate', ['linear'], ['heatmap-density'],
                    0,    'rgba(0,0,0,0)',
                    0.15, 'rgba(0,0,0,0)',
                    0.25, 'rgba(0,0,255,0.8)',
                    0.4,  'rgba(0,255,255,0.85)',
                    0.55, 'rgba(0,255,0,0.9)',
                    0.7,  'rgba(255,255,0,0.93)',
                    0.85, 'rgba(255,0,0,0.97)',
                    1.0,  'rgba(127,0,0,1)'
                ]
            },
            layout: { visibility: document.getElementById('toggle-landprice-heat')?.checked ? 'visible' : 'none' }
        }, 'landprice-layer');
    }

    // --- 将来推計人口 1kmメッシュ ダイバージングコロプレス (2050年/2020年比) ---
    if (!map.getSource('pop-mesh')) map.addSource('pop-mesh', { type: 'geojson', data: './tokyo_future_population.geojson' });
    if (!map.getLayer('pop-mesh-layer')) {
        const ratioExpr = ['case',
            ['>', ['get', 'PTN_2020'], 0],
            ['/', ['to-number', ['get', 'PTN_2050']], ['to-number', ['get', 'PTN_2020']]],
            1.0
        ];
        map.addLayer({
            id: 'pop-mesh-layer', type: 'fill', source: 'pop-mesh',
            paint: {
                'fill-color': [
                    'interpolate', ['linear'], ratioExpr,
                    0.0,  '#67001f',
                    0.5,  '#b2182b',
                    0.7,  '#d6604d',
                    0.85, '#f4a582',
                    0.95, '#fddbc7',
                    1.0,  '#f7f7f7',
                    1.05, '#d1e5f0',
                    1.15, '#92c5de',
                    1.3,  '#4393c3',
                    1.5,  '#2166ac',
                    2.0,  '#053061'
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
                'fill-color': [
                    'step', ['to-number', ['get', 'PTN_2025']],
                    '#FFFF00',
                    500,  '#FFD700',
                    1000, '#FFA500',
                    2500, '#FF6600',
                    5000, '#E83000',
                    10000, '#B20000'
                ],
                'fill-opacity': 0.5,
                'fill-outline-color': 'rgba(100,100,100,0.3)'
            },
            layout: { visibility: document.getElementById('toggle-pop-mesh-total')?.checked ? 'visible' : 'none' }
        }, 'unclustered-point');
    }

    // --- 3D建物 ---
    // MapLibre ではスタイルに含まれる building ソースを利用
    // OpenMapTiles ベースのスタイルなら 'openmaptiles' ソース
    setup3DBuildings();
}

function setup3DBuildings() {
    if (map.getLayer('3d-buildings')) return;
    // スタイルに含まれるベクタータイルソースを探す
    const sources = map.getStyle()?.sources || {};
    let vectorSource = null;
    for (const [name, src] of Object.entries(sources)) {
        if (src.type === 'vector') { vectorSource = name; break; }
    }
    if (!vectorSource) return;
    try {
        map.addLayer({
            id: '3d-buildings', source: vectorSource, 'source-layer': 'building',
            type: 'fill-extrusion',
            minzoom: 14,
            paint: {
                'fill-extrusion-color': '#aaa',
                'fill-extrusion-opacity': 0.5,
                'fill-extrusion-height': [
                    'coalesce',
                    ['get', 'render_height'],
                    ['get', 'height'],
                    5
                ],
                'fill-extrusion-base': [
                    'coalesce',
                    ['get', 'render_min_height'],
                    0
                ]
            },
            layout: { visibility: document.getElementById('toggle-3d')?.checked ? 'visible' : 'none' }
        });
    } catch (e) {
        console.warn('3D buildings layer not available for this style:', e.message);
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

        const pointFeatures = geojson.features
            .filter(f => f.geometry?.coordinates?.length > 0)
            .map(feat => {
                const coords = feat.geometry.coordinates;
                const mid = coords[Math.floor(coords.length / 2)];
                return { type: 'Feature', geometry: { type: 'Point', coordinates: mid }, properties: feat.properties };
            });

        state.stationData = pointFeatures;

        map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: pointFeatures } });

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
        if (state.isMunicipalityMode) { handleMunicipalityClick(e); return; }
        if (state.isCircleMode) { handleCircleClick(e); return; }

        const props = map.queryRenderedFeatures(e.point, { layers: ['unclustered-point'] });
        if (props.length > 0) { selectProperty(props[0].properties.id, e.lngLat); return; }

        const land = map.queryRenderedFeatures(e.point, { layers: ['landprice-layer'] });
        if (land.length > 0) { showAnalysisPopup(land[0], e.lngLat); return; }

        const pop = map.queryRenderedFeatures(e.point, { layers: ['pop-mesh-layer', 'pop-mesh-total-layer'] });
        if (pop.length > 0) { showPopulationPopup(pop[0], e.lngLat); return; }

        const zoning = map.queryRenderedFeatures(e.point, { layers: ['zoning-layer'] });
        if (zoning.length > 0) { showAnalysisPopup(zoning[0], e.lngLat); return; }
    });

    map.on('mousemove', (e) => {
        if (!state.isCircleMode || !state.circleCenter) return;
        const radiusKm = turf.distance(turf.point(state.circleCenter), turf.point([e.lngLat.lng, e.lngLat.lat]), { units: 'kilometers' });
        if (radiusKm < 0.001) return;
        const circle = turf.circle(state.circleCenter, radiusKm, { steps: 64, units: 'kilometers' });
        map.getSource('circle-select').setData({ type: 'FeatureCollection', features: [circle] });
        const radiusM = Math.round(radiusKm * 1000);
        showRadiusLabel(e.point, radiusM >= 1000 ? `半径 ${radiusKm.toFixed(2)}km` : `半径 ${radiusM}m`);
    });

    const hoverLayers = ['unclustered-point', 'landprice-layer', 'pop-mesh-layer', 'pop-mesh-total-layer', 'zoning-layer'];
    hoverLayers.forEach(l => {
        map.on('mouseenter', l, () => { if(!state.isDrawingMode && !state.isCircleMode) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', l, () => { if(!state.isCircleMode) map.getCanvas().style.cursor = ''; });
    });

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

    state.currentPopup = new maplibregl.Popup().setLngLat(lngLat).setHTML(html).setMaxWidth("none").addTo(map);

    if (f.layer.id === 'landprice-layer') {
        setTimeout(() => {
            const ctx = document.getElementById('landTrendChart');
            if (ctx) {
                const trendData = [
                    p.L01_101, p.L01_102, p.L01_103, p.L01_104, p.L01_105
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

    state.currentPopup = new maplibregl.Popup()
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
    const score = calculatePropertyScore(feature);
    const scoreColor = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444';
    const scoreLabel = score >= 70 ? '優良' : score >= 40 ? '標準' : '要注意';
    const html = `
        <div style="min-width:340px;max-width:420px;padding:4px;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                <span style="font-size:14px;font-weight:bold;">${fmt(p.name)}</span>
                <span style="background:${getAssetColor(p.assetType)};color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;">${fmt(p.assetType)}</span>
                <span style="background:${scoreColor};color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">${score}点 ${scoreLabel}</span>
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
            <div style="border-top:1px solid #e5e7eb;padding-top:8px;margin-top:8px;">
                <div style="font-size:10px;font-weight:600;color:#374151;margin-bottom:6px;">周辺情報 (半径1km)</div>
                <div id="nearby-info-${uid}" style="font-size:10px;color:#6b7280;">分析中...</div>
            </div>
        </div>`;

    state.currentPopup = new maplibregl.Popup({ className: 'property-popup', maxWidth: '440px' })
        .setLngLat(coords).setHTML(html).addTo(map);
    state.currentPopup.on('close', () => { document.querySelectorAll('.property-card').forEach(c => c.classList.remove('active-card')); });

    document.querySelectorAll('.property-card').forEach(c => c.classList.remove('active-card'));
    const card = document.getElementById(`card-${id}`);
    if (card) { card.classList.add('active-card'); card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }

    setTimeout(() => {
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

    // 周辺情報の分析
    setTimeout(() => {
        const el = document.getElementById(`nearby-info-${uid}`);
        if (el) el.innerHTML = buildNearbyInfo(feature);
    }, 200);
}

/* ==========================================================
 * 競合・周辺物件サジェスト
 * ========================================================== */
function buildNearbyInfo(feature) {
    const coords = feature.geometry.coordinates;
    const pt = turf.point(coords);
    const radiusKm = 1;
    let html = '';

    // 1. 周辺物件
    const nearbyProps = state.geoData.features.filter(f => {
        if (f.properties.id === feature.properties.id) return false;
        return turf.distance(pt, turf.point(f.geometry.coordinates), { units: 'kilometers' }) <= radiusKm;
    });
    if (nearbyProps.length > 0) {
        html += `<div style="margin-bottom:6px;"><b style="color:#2563eb;">類似物件: ${nearbyProps.length}件</b></div>`;
        html += '<div style="max-height:80px;overflow-y:auto;">';
        nearbyProps.slice(0, 10).forEach(f => {
            const p = f.properties;
            const dist = (turf.distance(pt, turf.point(f.geometry.coordinates), { units: 'kilometers' }) * 1000).toFixed(0);
            const color = getAssetColor(p.assetType);
            html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid #f3f4f6;cursor:pointer;" onclick="selectProperty('${p.id}')">
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;"><span style="color:${color};font-weight:600;">${iconMap[p.assetType] || '🏢'}</span> ${p.name}</span>
                <span style="color:#9ca3af;white-space:nowrap;margin-left:8px;">${dist}m</span>
            </div>`;
        });
        html += '</div>';
    } else {
        html += '<div style="margin-bottom:6px;color:#9ca3af;">半径1km内に他の物件はありません</div>';
    }

    // 2. 最寄り駅
    if (state.stationData.length > 0) {
        const nearStations = state.stationData
            .map(s => ({ ...s, dist: turf.distance(pt, turf.point(s.geometry.coordinates), { units: 'kilometers' }) }))
            .filter(s => s.dist <= radiusKm)
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 5);
        if (nearStations.length > 0) {
            html += `<div style="margin-top:6px;margin-bottom:4px;"><b style="color:#0369a1;">最寄り駅</b></div>`;
            nearStations.forEach(s => {
                const p = s.properties;
                const dist = (s.dist * 1000).toFixed(0);
                const passengers = p.S12_057 ? parseInt(p.S12_057).toLocaleString() : '-';
                html += `<div style="display:flex;justify-content:space-between;padding:1px 0;font-size:10px;">
                    <span>🚉 ${p.S12_001} (${cleanLineName(p.S12_003)})</span>
                    <span style="color:#9ca3af;">${dist}m / ${passengers}人</span>
                </div>`;
            });
        }
    }

    // 3. 周辺地価
    try {
        const landSource = map.getSource('landprice');
        if (landSource && landSource._data) {
            const landData = typeof landSource._data === 'string' ? null : landSource._data;
            if (landData && landData.features) {
                const nearLand = landData.features
                    .filter(f => f.geometry && turf.distance(pt, turf.point(f.geometry.coordinates), { units: 'kilometers' }) <= radiusKm)
                    .sort((a, b) => turf.distance(pt, turf.point(a.geometry.coordinates)) - turf.distance(pt, turf.point(b.geometry.coordinates)))
                    .slice(0, 3);
                if (nearLand.length > 0) {
                    html += `<div style="margin-top:6px;margin-bottom:4px;"><b style="color:#d97706;">周辺地価公示</b></div>`;
                    nearLand.forEach(f => {
                        const p = f.properties;
                        const price = p.L01_008 ? Math.round(parseInt(p.L01_008) / 10000).toLocaleString() + '万円/㎡' : '-';
                        const dist = (turf.distance(pt, turf.point(f.geometry.coordinates), { units: 'kilometers' }) * 1000).toFixed(0);
                        html += `<div style="display:flex;justify-content:space-between;padding:1px 0;font-size:10px;">
                            <span>📍 ${p.L01_025 || '-'}</span>
                            <span style="color:#d97706;font-weight:600;">${price} (${dist}m)</span>
                        </div>`;
                    });
                }
            }
        }
    } catch(e) {}

    return html || '<span style="color:#9ca3af;">周辺情報なし</span>';
}

/* ==========================================================
 * 物件スコアリング（投資判断支援）
 * 100点満点: 利回り(25) + 駅距離(25) + 人口動態(20) + 地価安定性(15) + ハザード(15)
 * ========================================================== */
function calculatePropertyScore(feature) {
    const coords = feature.geometry.coordinates;
    const pt = turf.point(coords);
    const p = feature.properties;
    let score = 0;

    // 1. 利回りスコア (25点) — 3〜7%が最適ゾーン
    let latestYield = null;
    for (let y = 2026; y >= 2020; y--) {
        const v = p[`利回り${y}`];
        if (v != null && v !== '') { latestYield = Number(v) * 100; break; }
    }
    if (latestYield !== null) {
        if (latestYield >= 3 && latestYield <= 7) score += 25;
        else if (latestYield >= 2 && latestYield <= 10) score += 18;
        else if (latestYield > 0) score += 10;
    } else {
        score += 12; // データなしは中立
    }

    // 2. 駅距離スコア (25点)
    if (state.stationData.length > 0) {
        const nearestDist = state.stationData
            .map(s => turf.distance(pt, turf.point(s.geometry.coordinates), { units: 'kilometers' }))
            .sort((a, b) => a - b)[0] || 999;
        const distM = nearestDist * 1000;
        if (distM <= 200) score += 25;
        else if (distM <= 500) score += 20;
        else if (distM <= 800) score += 15;
        else if (distM <= 1500) score += 8;
        else score += 3;
    } else {
        score += 12;
    }

    // 3. 人口動態スコア (20点) — 周辺メッシュの2050/2020比率
    try {
        const popSource = map.getSource('pop-mesh');
        if (popSource && popSource._data && popSource._data.features) {
            const nearPop = popSource._data.features
                .filter(f => f.geometry && turf.booleanPointInPolygon(pt, f))
                [0];
            if (nearPop) {
                const base = nearPop.properties.PTN_2020 || 0;
                const future = nearPop.properties.PTN_2050 || 0;
                if (base > 0) {
                    const ratio = future / base;
                    if (ratio >= 1.1) score += 20;
                    else if (ratio >= 1.0) score += 16;
                    else if (ratio >= 0.9) score += 12;
                    else if (ratio >= 0.8) score += 7;
                    else score += 3;
                } else { score += 10; }
            } else { score += 10; }
        } else { score += 10; }
    } catch(e) { score += 10; }

    // 4. 地価安定性スコア (15点) — 周辺地価の水準
    try {
        const landSource = map.getSource('landprice');
        if (landSource && landSource._data && landSource._data.features) {
            const nearLand = landSource._data.features
                .filter(f => f.geometry && turf.distance(pt, turf.point(f.geometry.coordinates), { units: 'kilometers' }) <= 1)
                .map(f => parseInt(f.properties.L01_008) || 0)
                .filter(v => v > 0);
            if (nearLand.length > 0) {
                const avgPrice = nearLand.reduce((a, b) => a + b, 0) / nearLand.length;
                if (avgPrice >= 500000) score += 15;      // 50万/㎡以上: 都心一等地
                else if (avgPrice >= 200000) score += 12;  // 20万以上: 優良立地
                else if (avgPrice >= 100000) score += 9;
                else score += 5;
            } else { score += 7; }
        } else { score += 7; }
    } catch(e) { score += 7; }

    // 5. ハザードリスクスコア (15点) — リスクなしが高得点
    // 簡易判定: ハザードレイヤーがオンの場合、物件位置にタイルがあるかチェック
    let hazardPenalty = 0;
    const hazardLayers = ['flood-l2', 'flood-l1', 'tsunami', 'hightide', 'landslide-flow', 'landslide-steep'];
    hazardLayers.forEach(lid => {
        try {
            if (map.getSource(lid)) {
                const rendered = map.queryRenderedFeatures(map.project(coords), { layers: [lid] });
                if (rendered.length > 0) hazardPenalty += 2;
            }
        } catch(e) {}
    });
    score += Math.max(15 - hazardPenalty, 0);

    return Math.min(Math.max(Math.round(score), 0), 100);
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
    if (open) onYieldSlider();
}

function onYieldSlider() {
    const minEl = document.getElementById('yield-min');
    const maxEl = document.getElementById('yield-max');
    let minVal = parseFloat(minEl.value);
    let maxVal = parseFloat(maxEl.value);
    if (minVal > maxVal) { minEl.value = maxVal; minVal = maxVal; }
    if (maxVal < minVal) { maxEl.value = minVal; maxVal = minVal; }

    const rangeMax = 20;
    const minPct = minVal / rangeMax * 100;
    const maxPct = maxVal / rangeMax * 100;

    const fill = document.getElementById('yield-track-fill');
    if (fill) { fill.style.left = minPct + '%'; fill.style.width = (maxPct - minPct) + '%'; }

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
    const area = document.getElementById('yield-slider-area');
    const arrow = document.getElementById('yield-toggle-arrow');
    const label = document.getElementById('yield-range-label');
    if (area) area.style.display = 'none';
    if (arrow) arrow.textContent = '▶';
    if (label) label.textContent = '';
    onYieldSlider();

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
        if (!map.getSource('terrain-dem')) {
            map.addSource('terrain-dem', {
                type: 'raster-dem',
                url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`,
                tileSize: 256
            });
        }
        map.setTerrain({ source: 'terrain-dem', exaggeration: 1.5 });
    } else {
        map.setTerrain(null);
    }
}

function toggleLayer(id) {
    let cbId = 'toggle-' + id.replace('-layer', '').replace('3d-buildings', '3d');

    if (id === 'pop-mesh-layer') cbId = 'toggle-pop-mesh';
    if (id === 'pop-mesh-total-layer') cbId = 'toggle-pop-mesh-total';
    if (id === 'landprice-heat') cbId = 'toggle-landprice-heat';
    if (id === 'stations-circle') cbId = 'toggle-stations';

    const cb = document.getElementById(cbId);
    if (map.getLayer(id) && cb) {
        const visibility = cb.checked ? 'visible' : 'none';
        map.setLayoutProperty(id, 'visibility', visibility);

        if (id === 'landprice-layer' && map.getLayer('landprice-label')) {
            map.setLayoutProperty('landprice-label', 'visibility', visibility);
        }
        if (id === 'stations-circle' && map.getLayer('stations-label')) {
            map.setLayoutProperty('stations-label', 'visibility', visibility);
        }

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
 * ========================================================== */

function getPrefectureCode() {
    const { lng, lat } = map.getCenter();
    if (lat >= 35.48 && lat <= 35.9  && lng >= 138.9 && lng <= 140.0) return '13';
    if (lat >= 34.3  && lat <= 35.0  && lng >= 135.0 && lng <= 135.8) return '27';
    if (lat >= 34.8  && lat <= 35.3  && lng >= 136.5 && lng <= 137.2) return '23';
    if (lat >= 35.0  && lat <= 35.6  && lng >= 139.2 && lng <= 139.8) return '14';
    if (lat >= 35.7  && lat <= 36.3  && lng >= 139.3 && lng <= 139.9) return '11';
    return '13';
}

async function fetchReinfolib(endpoint, params) {
    if (!REINFOLIB_BASE) throw new Error('REINFOLIB API はローカル環境でのみ利用可能です');
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

const geocodeCache = {};

/**
 * 住所文字列を MapTiler Geocoding API で座標 [lng, lat] に変換する
 */
async function geocodeAddress(address) {
    if (address in geocodeCache) return geocodeCache[address];
    try {
        const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(address)}.json?key=${MAPTILER_KEY}&language=ja&country=jp&limit=1`;
        const res = await fetch(url);
        const json = await res.json();
        geocodeCache[address] = (json.features && json.features.length > 0) ? json.features[0].center : null;
    } catch (e) {
        geocodeCache[address] = null;
    }
    return geocodeCache[address];
}

async function toGeoJSON(data) {
    const latKeys = ['latitude', 'Latitude', 'lat', '緯度'];
    const lngKeys = ['longitude', 'Longitude', 'lng', '経度'];
    const hasCoords = d => latKeys.some(k => d[k]) && lngKeys.some(k => d[k]);

    if (data.length > 0 && hasCoords(data[0])) {
        const features = data.filter(hasCoords).map(d => {
            const lat = parseFloat(latKeys.reduce((v, k) => v ?? d[k], null));
            const lng = parseFloat(lngKeys.reduce((v, k) => v ?? d[k], null));
            return { type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: d };
        });
        return { type: 'FeatureCollection', features };
    }

    const MAX_GEOCODE = 500;
    const uniqueAddresses = [...new Set(
        data.map(d => `${d.Prefecture || ''}${d.Municipality || ''}${d.DistrictName || ''}`)
    )].slice(0, MAX_GEOCODE);
    await Promise.all(uniqueAddresses.map(geocodeAddress));

    const jitter = () => (Math.random() - 0.5) * 0.002;
    const features = data.slice(0, 10000).flatMap(d => {
        const address = `${d.Prefecture || ''}${d.Municipality || ''}${d.DistrictName || ''}`;
        const coords = geocodeCache[address];
        if (!coords) return [];
        return [{ type: 'Feature', geometry: { type: 'Point', coordinates: [coords[0] + jitter(), coords[1] + jitter()] }, properties: d }];
    });
    return { type: 'FeatureCollection', features };
}

function upsertClusteredLayer(sourceId, geojson, clusterColor, pointColor, onClickFn) {
    if (map.getSource(sourceId)) {
        map.getSource(sourceId).setData(geojson);
        return;
    }

    map.addSource(sourceId, {
        type: 'geojson', data: geojson,
        cluster: true, clusterMaxZoom: 15, clusterRadius: 50
    });

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

    map.addLayer({
        id: `${sourceId}-cluster-count`, type: 'symbol', source: sourceId,
        filter: ['has', 'point_count'],
        layout: {
            'text-field': '{point_count_abbreviated}',
            'text-size': 12
        },
        paint: { 'text-color': '#ffffff' }
    });

    map.addLayer({
        id: `${sourceId}-point`, type: 'circle', source: sourceId,
        filter: ['!', ['has', 'point_count']],
        paint: {
            'circle-radius': 6, 'circle-color': pointColor,
            'circle-stroke-width': 1.5, 'circle-stroke-color': '#ffffff', 'circle-opacity': 0.9
        }
    });

    map.on('click', `${sourceId}-clusters`, (e) => {
        const feature = map.queryRenderedFeatures(e.point, { layers: [`${sourceId}-clusters`] })[0];
        map.getSource(sourceId).getClusterExpansionZoom(feature.properties.cluster_id, (err, zoom) => {
            if (!err) map.easeTo({ center: feature.geometry.coordinates, zoom });
        });
    });

    [`${sourceId}-clusters`, `${sourceId}-point`].forEach(id => {
        map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    });

    map.on('click', `${sourceId}-point`, (e) => {
        if (e.features.length > 0) onClickFn(e.features[0].properties, e.lngLat);
    });
}

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
    state.currentPopup = new maplibregl.Popup().setLngLat(lngLat).setHTML(html).setMaxWidth("none").addTo(map);
}

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
    state.currentPopup = new maplibregl.Popup().setLngLat(lngLat).setHTML(html).setMaxWidth("none").addTo(map);
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
        state.circleCenter = lngLat;
    } else {
        const radiusKm = turf.distance(turf.point(state.circleCenter), turf.point(lngLat), { units: 'kilometers' });
        if (radiusKm < 0.01) return;
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

        map.addLayer({
            id: 'municipality-fill', type: 'fill', source: 'municipalities',
            paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0 }
        }, 'unclustered-point');

        map.addLayer({
            id: 'municipality-selected', type: 'fill', source: 'municipalities',
            filter: ['==', ['get', 'N03_004'], '__none__'],
            paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.2 }
        }, 'unclustered-point');

        map.addLayer({
            id: 'municipality-border', type: 'line', source: 'municipalities',
            paint: { 'line-color': '#3b82f6', 'line-width': 1, 'line-opacity': 0 }
        });

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
        if (state.isDrawingMode) toggleDrawMode();
        if (state.isCircleMode || state.circlePolygon) clearCircleMode();
        state.isMunicipalityMode = true;
        map.getCanvas().style.cursor = 'pointer';
        if (btn) { btn.innerHTML = '✖ 市区町村を選択中...'; btn.classList.add('active-cancel'); }
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
    if (map.getLayer('municipality-border')) map.setPaintProperty('municipality-border', 'line-opacity', 0);
    if (map.getLayer('municipality-fill')) map.setPaintProperty('municipality-fill', 'fill-opacity', 0);
    if (map.getLayer('municipality-selected')) map.setFilter('municipality-selected', ['==', ['get', 'N03_004'], '__none__']);
    if (map.getLayer('municipality-hover')) map.setFilter('municipality-hover', ['==', ['get', 'N03_004'], '__none__']);
    applyFilters();
}

function handleMunicipalityClick(e) {
    if (!state._municipalityGeoJSON) return;
    const point = turf.point([e.lngLat.lng, e.lngLat.lat]);
    const hit = state._municipalityGeoJSON.features.find(f =>
        f.geometry && turf.booleanPointInPolygon(point, f)
    );
    if (!hit) return;
    const name = hit.properties.N03_004;
    if (!name) return;

    const polygons = state._municipalityGeoJSON.features.filter(f => f.properties.N03_004 === name);
    state.municipalityPolygons = polygons;
    state.municipalityName = name;
    state.isMunicipalityMode = false;
    map.getCanvas().style.cursor = '';

    const btn = document.getElementById('btn-municipality-toggle');
    if (btn) { btn.innerHTML = `✖ ${name} (解除)`; btn.classList.remove('active-cancel'); btn.classList.add('active'); }

    if (map.getLayer('municipality-selected')) map.setFilter('municipality-selected', ['==', ['get', 'N03_004'], name]);
    if (map.getLayer('municipality-hover')) map.setFilter('municipality-hover', ['==', ['get', 'N03_004'], '__none__']);

    applyFilters();
}

function toggleDrawMode() {
    const btn = document.getElementById('btn-draw-toggle');
    const hasPolygon = draw.getAll().features.length > 0;

    if (!state.isDrawingMode && !hasPolygon) {
        if (state.isCircleMode || state.circlePolygon) clearCircleMode();
        if (state.isMunicipalityMode || state.municipalityPolygons) clearMunicipalityMode();
        draw.changeMode('draw_polygon');
        btn.innerHTML = '🗑️ 選択解除';
        btn.classList.add('active-cancel');
        btn.classList.remove('active');
        state.isDrawingMode = true;
    } else {
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
        const pops = document.getElementsByClassName('maplibregl-popup');
        while (pops[0]) pops[0].remove();
    } else {
        Array.from(document.getElementsByClassName('maplibregl-popup')).forEach(p => { if (!p.classList.contains('property-popup')) p.remove(); });
    }
}

function clearAllLayers() {
    document.querySelectorAll('input[type="checkbox"]').forEach(chk => chk.checked = false);
    ['zoning-layer', 'landprice-layer', 'landprice-label', 'landprice-heat', 'pop-mesh-layer', 'pop-mesh-total-layer', 'stations-circle', 'stations-label', '3d-buildings'].forEach(id => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none'); });
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

    const checkedLayers = [...document.querySelectorAll('#layer-content input[type="checkbox"]:not(.hazard-chk):checked')]
        .map(el => el.id.replace('toggle-', ''));
    if (checkedLayers.length) p.set('layers', checkedLayers.join(','));

    const checkedHazards = [...document.querySelectorAll('.hazard-chk:checked')]
        .map(el => el.getAttribute('data-layer'));
    if (checkedHazards.length) p.set('hazards', checkedHazards.join(','));

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
  .header { border-bottom: 3px solid #1e3a5f; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; }
  .header-title { font-size: 22px; font-weight: 800; color: #1e3a5f; letter-spacing: 0.05em; }
  .header-sub { font-size: 11px; color: #6b7280; margin-top: 3px; }
  .header-right { text-align: right; font-size: 11px; color: #6b7280; line-height: 1.7; }
  .summary-grid { display: flex; gap: 10px; margin-bottom: 14px; }
  .summary-card { flex: 1; background: #f0f4ff; border-left: 4px solid #3b82f6; border-radius: 4px; padding: 8px 12px; }
  .summary-card .label { font-size: 10px; color: #6b7280; margin-bottom: 2px; }
  .summary-card .value { font-size: 20px; font-weight: 800; color: #1e3a5f; }
  .summary-card .unit  { font-size: 11px; color: #6b7280; margin-left: 2px; }
  .map-section { margin-bottom: 14px; }
  .section-title { font-size: 12px; font-weight: 700; color: #1e3a5f; border-left: 3px solid #3b82f6; padding-left: 8px; margin-bottom: 6px; }
  .map-img { width: 100%; height: auto; border: 1px solid #e5e7eb; border-radius: 4px; display: block; }
  .table-section { }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  thead tr { background: #1e3a5f; color: #fff; }
  thead th { padding: 6px 5px; text-align: left; font-weight: 600; white-space: nowrap; }
  tbody td { padding: 5px 5px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }
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

function changeBaseMap() {
    const key = document.getElementById('basemap-select').value;
    map.setStyle(getStyleUrl(key), { diff: false });
}

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

function toggleSidebar() {
    const sb = document.getElementById('sidebar');
    if (!sb) return;
    sb.classList.toggle('hidden');
    document.body.classList.toggle('list-open');
    const btn = document.getElementById('sidebar-toggle');
    if (btn) btn.innerText = sb.classList.contains('hidden') ? '一覧表示' : '一覧非表示';
}

map.on('style.load', async () => {
    try {
        await setupMapContent();
        await setupMunicipalityLayer();
        if (state.municipalityName && map.getLayer('municipality-selected')) {
            map.setFilter('municipality-selected', ['==', ['get', 'N03_004'], state.municipalityName]);
            if (map.getLayer('municipality-border')) map.setPaintProperty('municipality-border', 'line-opacity', 0.5);
            if (map.getLayer('municipality-fill')) map.setPaintProperty('municipality-fill', 'fill-opacity', 0.01);
        }
        if (state.geoData.features.length > 0) applyFilters();
        if (document.getElementById('toggle-terrain')?.checked) toggleTerrain();
        // 円選択の復元
        if (state.circlePolygon && map.getSource('circle-select')) {
            map.getSource('circle-select').setData({ type: 'FeatureCollection', features: [state.circlePolygon] });
        }
    } catch (e) {
        console.error('style.load handler error:', e);
    }
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

    state.currentPopup = new maplibregl.Popup()
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
/* ==========================================================
 * タイムライン・年次比較スライダー
 * ========================================================== */
const TIMELINE_YEARS = [2020, 2025, 2030, 2035, 2040, 2045, 2050];
let timelineInterval = null;

function toggleTimelinePanel() {
    const panel = document.getElementById('timeline-panel');
    const cb = document.getElementById('toggle-pop-mesh-total');
    if (!panel) return;
    panel.style.display = (cb && cb.checked) ? 'block' : 'none';
    if (panel.style.display === 'none' && timelineInterval) {
        clearInterval(timelineInterval);
        timelineInterval = null;
        const btn = document.getElementById('timeline-play-btn');
        if (btn) btn.textContent = '▶';
    }
}

function closeTimeline() {
    const panel = document.getElementById('timeline-panel');
    if (panel) panel.style.display = 'none';
    if (timelineInterval) { clearInterval(timelineInterval); timelineInterval = null; }
}

function onTimelineSlider() {
    const slider = document.getElementById('timeline-slider');
    const idx = parseInt(slider.value);
    const year = TIMELINE_YEARS[idx];
    document.getElementById('timeline-year-label').textContent = year + '年';
    updatePopMeshForYear(year);
}

function toggleTimelinePlay() {
    const btn = document.getElementById('timeline-play-btn');
    if (timelineInterval) {
        clearInterval(timelineInterval);
        timelineInterval = null;
        btn.textContent = '▶';
    } else {
        btn.textContent = '⏸';
        const slider = document.getElementById('timeline-slider');
        timelineInterval = setInterval(() => {
            let idx = parseInt(slider.value);
            idx = (idx + 1) % TIMELINE_YEARS.length;
            slider.value = idx;
            onTimelineSlider();
        }, 1500);
    }
}

function updatePopMeshForYear(year) {
    if (!map.getLayer('pop-mesh-total-layer')) return;
    const field = `PTN_${year}`;
    map.setPaintProperty('pop-mesh-total-layer', 'fill-color', [
        'step', ['to-number', ['get', field]],
        '#FFFF00',
        500,  '#FFD700',
        1000, '#FFA500',
        2500, '#FF6600',
        5000, '#E83000',
        10000, '#B20000'
    ]);

    // 増減レイヤーも連動更新（2020年比）
    if (map.getLayer('pop-mesh-layer')) {
        const ratioExpr = ['case',
            ['>', ['get', 'PTN_2020'], 0],
            ['/', ['to-number', ['get', field]], ['to-number', ['get', 'PTN_2020']]],
            1.0
        ];
        map.setPaintProperty('pop-mesh-layer', 'fill-color', [
            'interpolate', ['linear'], ratioExpr,
            0.0,  '#67001f',
            0.5,  '#b2182b',
            0.7,  '#d6604d',
            0.85, '#f4a582',
            0.95, '#fddbc7',
            1.0,  '#f7f7f7',
            1.05, '#d1e5f0',
            1.15, '#92c5de',
            1.3,  '#4393c3',
            1.5,  '#2166ac',
            2.0,  '#053061'
        ]);
    }
}

/* ==========================================================
 * カスタムデータアップロード
 * ========================================================== */
let uploadedData = null;
let uploadedColumns = [];

async function handleCustomUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    event.target.value = ''; // 同じファイルの再選択を許可

    try {
        const arrayBuffer = await file.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const jsonData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        if (jsonData.length === 0) { showToast('データが空です'); return; }

        uploadedData = jsonData;
        uploadedColumns = Object.keys(jsonData[0]);
        showUploadModal();
    } catch (e) {
        console.error('Upload error:', e);
        showToast('ファイルの読み込みに失敗しました');
    }
}

function showUploadModal() {
    const modal = document.getElementById('upload-modal');
    const fields = document.getElementById('upload-mapping-fields');
    if (!modal || !fields) return;

    const mappings = [
        { id: 'map-name', label: '物件名', required: false },
        { id: 'map-lat', label: '緯度', required: true },
        { id: 'map-lng', label: '経度', required: true },
        { id: 'map-address', label: '住所', required: false },
        { id: 'map-type', label: 'アセットタイプ', required: false },
    ];

    // 列名から自動推定
    const guess = (keywords) => {
        const col = uploadedColumns.find(c => keywords.some(k => c.includes(k)));
        return col || '';
    };

    fields.innerHTML = mappings.map(m => {
        let autoVal = '';
        if (m.id === 'map-lat') autoVal = guess(['緯度', 'lat', 'Lat', 'latitude']);
        if (m.id === 'map-lng') autoVal = guess(['経度', 'lng', 'Lng', 'lon', 'longitude']);
        if (m.id === 'map-name') autoVal = guess(['物件名', '名称', 'name', 'Name', 'ビル名']);
        if (m.id === 'map-address') autoVal = guess(['住所', '所在地', 'address', 'Address']);
        if (m.id === 'map-type') autoVal = guess(['アセット', 'タイプ', 'type', 'Type', '種類']);

        const options = uploadedColumns.map(c =>
            `<option value="${c}" ${c === autoVal ? 'selected' : ''}>${c}</option>`
        ).join('');
        return `<div style="margin-bottom:8px;">
            <label style="font-weight:600; color:#374151;">${m.label}${m.required ? ' *' : ''}</label>
            <select id="${m.id}" style="width:100%; padding:4px 6px; border:1px solid #d1d5db; border-radius:4px; margin-top:2px; font-size:12px;">
                <option value="">-- 選択しない --</option>
                ${options}
            </select>
        </div>`;
    }).join('');

    fields.innerHTML += `<div style="font-size:10px; color:#9ca3af; margin-top:4px;">プレビュー: ${uploadedData.length}件のデータ</div>`;

    modal.style.display = 'flex';
}

function closeUploadModal() {
    const modal = document.getElementById('upload-modal');
    if (modal) modal.style.display = 'none';
}

function applyCustomUpload() {
    if (!uploadedData) return;

    const latCol = document.getElementById('map-lat')?.value;
    const lngCol = document.getElementById('map-lng')?.value;
    const nameCol = document.getElementById('map-name')?.value;
    const addressCol = document.getElementById('map-address')?.value;
    const typeCol = document.getElementById('map-type')?.value;

    if (!latCol || !lngCol) {
        showToast('緯度・経度の列を選択してください');
        return;
    }

    const features = uploadedData
        .filter(row => {
            const lat = parseFloat(row[latCol]);
            const lng = parseFloat(row[lngCol]);
            return !isNaN(lat) && !isNaN(lng);
        })
        .map((row, i) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [parseFloat(row[lngCol]), parseFloat(row[latCol])] },
            properties: {
                ...row,
                id: row['物件ID'] || row['ID'] || `CUSTOM-${i}`,
                name: nameCol ? (row[nameCol] || '無題') : '無題',
                address: addressCol ? (row[addressCol] || '') : '',
                assetType: typeCol ? (row[typeCol] || 'その他') : 'その他'
            }
        }));

    if (features.length === 0) {
        showToast('有効な座標データが見つかりませんでした');
        return;
    }

    // 既存データにマージ
    state.geoData.features = [...state.geoData.features, ...features];
    populateContractFilter();
    applyFilters();
    closeUploadModal();
    showToast(`${features.length}件のデータを地図に追加しました`);
}

/* ==========================================================
 * AIエリア分析レポート（OpenAI API連携）
 * ========================================================== */
async function generateAIReport() {
    // エリア選択の確認
    const drawnData = draw.getAll();
    const drawPolygon = drawnData.features.length > 0 ? drawnData.features[0] : null;
    const activePolygon = drawPolygon || state.circlePolygon;
    const municipalityName = state.municipalityName;

    if (!activePolygon && !municipalityName) {
        showToast('先にエリアを選択してください（範囲選択・円選択・市区町村選択）');
        return;
    }

    if (!OPENAI_API_KEY || OPENAI_API_KEY === 'YOUR_OPENAI_API_KEY' || OPENAI_API_KEY === '') {
        showToast('config.js に OpenAI API キーを設定してください');
        return;
    }

    showToast('エリアデータを集計中...');

    // 1. エリア内の物件データ
    const areaProperties = state.currentFilteredData.filter(f => state.checkedIds.has(f.properties.id));
    const areaName = municipalityName || '選択エリア';

    // 2. エリア内の人口データ
    let popSummary = { pop2020: 0, pop2025: 0, pop2050: 0, meshCount: 0 };
    try {
        const popSource = map.getSource('pop-mesh');
        if (popSource && popSource._data && popSource._data.features) {
            popSource._data.features.forEach(f => {
                const pt = turf.centroid(f);
                const isInArea = activePolygon
                    ? turf.booleanPointInPolygon(pt, activePolygon)
                    : (state.municipalityPolygons || []).some(poly => turf.booleanPointInPolygon(pt, poly));
                if (isInArea) {
                    popSummary.pop2020 += (f.properties.PTN_2020 || 0);
                    popSummary.pop2025 += (f.properties.PTN_2025 || 0);
                    popSummary.pop2050 += (f.properties.PTN_2050 || 0);
                    popSummary.meshCount++;
                }
            });
        }
    } catch(e) {}

    // 3. エリア内の地価データ
    let landPrices = [];
    try {
        const landSource = map.getSource('landprice');
        if (landSource && landSource._data && landSource._data.features) {
            landSource._data.features.forEach(f => {
                if (!f.geometry) return;
                const pt = turf.point(f.geometry.coordinates);
                const isInArea = activePolygon
                    ? turf.booleanPointInPolygon(pt, activePolygon)
                    : (state.municipalityPolygons || []).some(poly => turf.booleanPointInPolygon(pt, poly));
                if (isInArea && f.properties.L01_008) {
                    landPrices.push(parseInt(f.properties.L01_008));
                }
            });
        }
    } catch(e) {}

    const avgLandPrice = landPrices.length > 0 ? Math.round(landPrices.reduce((a,b) => a+b, 0) / landPrices.length) : null;
    const maxLandPrice = landPrices.length > 0 ? Math.max(...landPrices) : null;
    const minLandPrice = landPrices.length > 0 ? Math.min(...landPrices) : null;

    // 4. アセット内訳
    const assetBreakdown = {};
    areaProperties.forEach(f => {
        const t = f.properties.assetType || 'その他';
        assetBreakdown[t] = (assetBreakdown[t] || 0) + 1;
    });

    // 5. 利回り統計
    let yields = [];
    areaProperties.forEach(f => {
        for (let y = 2026; y >= 2020; y--) {
            const v = f.properties[`利回り${y}`];
            if (v != null && v !== '') { yields.push(Number(v) * 100); break; }
        }
    });
    const avgYield = yields.length > 0 ? (yields.reduce((a,b) => a+b, 0) / yields.length).toFixed(2) : null;

    // 6. ChatGPT APIにデータを送信
    const popChangeRate = popSummary.pop2020 > 0
        ? ((popSummary.pop2050 / popSummary.pop2020 - 1) * 100).toFixed(1) : '不明';

    const prompt = `あなたは不動産投資分析の専門家です。以下のエリアデータを基に、投資判断に役立つ分析レポートを日本語で作成してください。

【対象エリア】${areaName}

【物件データ】
- 対象物件数: ${areaProperties.length}件
- アセット構成: ${Object.entries(assetBreakdown).map(([k,v]) => `${k}:${v}件`).join(', ') || 'なし'}
- 平均利回り: ${avgYield ? avgYield + '%' : 'データなし'}

【人口動態】
- 2020年人口: ${Math.round(popSummary.pop2020).toLocaleString()}人
- 2025年推計: ${Math.round(popSummary.pop2025).toLocaleString()}人
- 2050年推計: ${Math.round(popSummary.pop2050).toLocaleString()}人
- 2020→2050年変化率: ${popChangeRate}%

【地価情報】
- 地価公示地点数: ${landPrices.length}件
- 平均地価: ${avgLandPrice ? (avgLandPrice / 10000).toFixed(1) + '万円/㎡' : 'データなし'}
- 最高地価: ${maxLandPrice ? (maxLandPrice / 10000).toFixed(1) + '万円/㎡' : 'データなし'}
- 最低地価: ${minLandPrice ? (minLandPrice / 10000).toFixed(1) + '万円/㎡' : 'データなし'}

以下の構成でレポートを作成してください:
1. エリア概要（2-3文）
2. 投資魅力度の評価（5段階）
3. 人口動態分析（今後のリスク・機会）
4. 地価分析（トレンドと見通し）
5. 推奨アクション（3-5項目の箇条書き）
6. リスク要因（2-3項目）

各セクションは簡潔にまとめてください。`;

    showToast('ChatGPT APIでレポートを生成中...');

    try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7
            })
        });

        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const json = await res.json();
        const aiText = json.choices?.[0]?.message?.content || 'レポート生成に失敗しました';

        // レポートをHTML形式で表示
        showAIReportWindow(areaName, aiText, {
            properties: areaProperties,
            popSummary,
            avgLandPrice,
            avgYield,
            assetBreakdown
        });

        showToast('レポートを生成しました');
    } catch (err) {
        console.error('ChatGPT API error:', err);
        showToast(`レポート生成に失敗しました: ${err.message}`);
    }
}

function showAIReportWindow(areaName, aiText, data) {
    const date = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
    const mapImg = map.getCanvas().toDataURL('image/png');

    // Markdown風テキストをHTMLに変換（簡易）
    const formatText = (text) => {
        return text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/^### (.+)$/gm, '<h3 style="color:#1e3a5f;font-size:14px;margin:12px 0 6px;border-left:3px solid #3b82f6;padding-left:8px;">$1</h3>')
            .replace(/^## (.+)$/gm, '<h2 style="color:#1e3a5f;font-size:16px;margin:16px 0 8px;">$1</h2>')
            .replace(/^# (.+)$/gm, '<h1 style="color:#1e3a5f;font-size:18px;margin:16px 0 8px;">$1</h1>')
            .replace(/^[-*] (.+)$/gm, '<li style="margin:3px 0;">$1</li>')
            .replace(/(<li.*<\/li>\n?)+/g, '<ul style="padding-left:18px;margin:6px 0;">$&</ul>')
            .replace(/\n{2,}/g, '<br><br>')
            .replace(/\n/g, '<br>');
    };

    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>AIエリア分析レポート - ${areaName} (${date})</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Helvetica Neue", "Hiragino Kaku Gothic ProN", sans-serif; font-size: 12px; color: #1f2937; background: #fff; }
  .page { max-width: 800px; margin: 0 auto; padding: 30px; }
  .header { border-bottom: 3px solid #1e3a5f; padding-bottom: 10px; margin-bottom: 20px; }
  .header-title { font-size: 22px; font-weight: 800; color: #1e3a5f; }
  .header-sub { font-size: 12px; color: #6b7280; margin-top: 4px; }
  .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
  .summary-card { background: #f0f4ff; border-left: 4px solid #3b82f6; border-radius: 4px; padding: 10px; }
  .summary-card .label { font-size: 10px; color: #6b7280; }
  .summary-card .value { font-size: 20px; font-weight: 800; color: #1e3a5f; }
  .summary-card .unit { font-size: 10px; color: #6b7280; }
  .map-img { width: 100%; border: 1px solid #e5e7eb; border-radius: 4px; margin-bottom: 20px; }
  .ai-section { background: #fefce8; border: 1px solid #fde68a; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
  .ai-badge { display: inline-block; background: #7c3aed; color: #fff; font-size: 10px; padding: 2px 8px; border-radius: 10px; margin-bottom: 10px; }
  .ai-content { font-size: 12px; line-height: 1.8; color: #374151; }
  .footer { border-top: 1px solid #e5e7eb; padding-top: 10px; font-size: 10px; color: #9ca3af; display: flex; justify-content: space-between; }
  @media print {
    @page { size: A4; margin: 10mm; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="header-title">AIエリア分析レポート: ${areaName}</div>
    <div class="header-sub">REI-Map AI Analysis Report | ${date}</div>
  </div>

  <div class="summary-grid">
    <div class="summary-card">
      <div class="label">対象物件数</div>
      <div class="value">${data.properties.length}<span class="unit">件</span></div>
    </div>
    <div class="summary-card">
      <div class="label">平均利回り</div>
      <div class="value">${data.avgYield || '-'}<span class="unit">%</span></div>
    </div>
    <div class="summary-card">
      <div class="label">平均地価</div>
      <div class="value">${data.avgLandPrice ? (data.avgLandPrice / 10000).toFixed(1) : '-'}<span class="unit">万円/㎡</span></div>
    </div>
    <div class="summary-card">
      <div class="label">人口変化率</div>
      <div class="value">${data.popSummary.pop2020 > 0 ? ((data.popSummary.pop2050 / data.popSummary.pop2020 - 1) * 100).toFixed(1) : '-'}<span class="unit">%</span></div>
    </div>
  </div>

  <img class="map-img" src="${mapImg}" alt="Map">

  <div class="ai-section">
    <span class="ai-badge">🤖 AI分析 (ChatGPT)</span>
    <div class="ai-content">${formatText(aiText)}</div>
  </div>

  <div class="footer">
    <span>本レポートはAI（ChatGPT）により自動生成されました。投資判断は必ず専門家にご相談ください。</span>
    <span>${date}</span>
  </div>
</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'width=900,height=800');
    if (win) win.addEventListener('unload', () => URL.revokeObjectURL(url), { once: true });
}

function renderPopulationChart(canvas, labels, data, base) {
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
