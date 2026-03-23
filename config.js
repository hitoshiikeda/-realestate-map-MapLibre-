/**
 * REI-Map 設定ファイル
 * マップトークン、レイヤー定義、マスタデータを管理します。
 *
 * 注意: OpenAI / REINFOLIB の API キーはフロントエンドに含めず、
 * ローカル環境でのみ利用してください。
 */

// 1. MapTiler API キー（ベースマップ・地形タイル用）
//    フロントエンド公開キー — MapTiler のダッシュボードで
//    許可ドメイン（リファラ制限）を設定してください。
const MAPTILER_KEY = 'HatWHrzBIqdKDRT4WwBq';

// ベースマップスタイル定義（MapLibre 用）
const BASE_STYLES = {
    'style-light':     `https://api.maptiler.com/maps/dataviz-light/style.json?key=${MAPTILER_KEY}`,
    'style-streets':   `https://api.maptiler.com/maps/jp-mierune-streets/style.json?key=${MAPTILER_KEY}`,
    'style-satellite': `https://api.maptiler.com/maps/hybrid/style.json?key=${MAPTILER_KEY}`,
    'style-dark':      `https://api.maptiler.com/maps/jp-mierune-dark/style.json?key=${MAPTILER_KEY}`,
};

// OpenAI API キー（AIエリア分析レポート用・AI投資検証用）
// GitHub Pages では利用不可 — ローカル環境で config.js を上書きして設定してください
const OPENAI_API_KEY = '';

// Anthropic Claude API キー（AI投資検証用 — OpenAIの代わりに使用可能）
// GitHub Pages では利用不可 — ローカル環境で config.js を上書きして設定してください
const CLAUDE_API_KEY = '';

// 不動産情報ライブラリ API
// GitHub Pages では利用不可 — ローカル環境で proxy.js を起動して利用してください
const REINFOLIB_API_KEY = '';
const REINFOLIB_BASE = '';

// 2. ハザードマップ（重ねるハザードマップ）の設定
const HAZARD_CONFIG = {
    'flood-l2': { url: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png', legend: './images/legend_flood_l2.png', name: '洪水浸水想定区域（想定最大規模）' },
    'flood-l1': { url: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l1_shinsuishin_newlegend_data/{z}/{x}/{y}.png', legend: './images/legend_flood_planned.png', name: '洪水浸水想定区域（計画規模）' },
    'flood-duration': { url: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_keizoku_data/{z}/{x}/{y}.png', legend: './images/legend_flood_duration.png', name: '浸水継続時間（想定最大規模）' },
    'flood-collapse-flow': { url: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_kaokutoukai_hanran_data/{z}/{x}/{y}.png', legend: './images/legend_flood_collapse.png', name: '家屋倒壊等氾濫想定区域（氾濫流）' },
    'flood-collapse-erosion': { url: 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_kaokutoukai_kagan_data/{z}/{x}/{y}.png', legend: './images/legend_flood_collapse2.png', name: '家屋倒壊等氾濫想定区域（河岸侵食）' },
    'inland-flood': { url: 'https://disaportaldata.gsi.go.jp/raster/02_naisui_data/{z}/{x}/{y}.png', legend: './images/legend_inland_flood.png', name: '内水（雨水出水）浸水想定区域' },
    'hightide': { url: 'https://disaportaldata.gsi.go.jp/raster/03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png', legend: './images/legend_hightide.png', name: '高潮浸水想定区域' },
    'tsunami': { url: 'https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png', legend: './images/legend_tsunami.png', name: '津波浸水想定' },
    'landslide-flow': { url: 'https://disaportaldata.gsi.go.jp/raster/05_dosekiryukeikaikuiki/{z}/{x}/{y}.png', legend: './images/legend_landslide.png', name: '土砂災害警戒区域（土石流）' },
    'landslide-steep': { url: 'https://disaportaldata.gsi.go.jp/raster/05_kyukeishakeikaikuiki/{z}/{x}/{y}.png', legend: './images/legend_landslide2.png', name: '土砂災害警戒区域（急傾斜地の崩壊）' },
    'landslide-slide': { url: 'https://disaportaldata.gsi.go.jp/raster/05_jisuberikeikaikuiki/{z}/{x}/{y}.png', legend: './images/legend_landslide3.png', name: '土砂災害警戒区域（地すべり）' },
    'avalanche': { url: 'https://disaportaldata.gsi.go.jp/raster/05_nadarekikenkasyo/{z}/{x}/{y}.png', legend: './images/legend_avalanche.png', name: '雪崩危険箇所' }
};

// 3. 用途地域マスタ定義（国土数値情報 A29_004コードに対応）
const ZONING_TYPE_MAP = {
    '1': '第一種低層住居専用地域',
    '2': '第二種低層住居専用地域',
    '3': '第一種中高層住居専用地域',
    '4': '第二種中高層住居専用地域',
    '5': '第一種住居地域',
    '6': '第二種住居地域',
    '7': '準住居地域',
    '8': '田園住居地域',
    '9': '近隣商業地域',
    '10': '商業地域',
    '11': '準工業地域',
    '12': '工業地域',
    '13': '工業専用地域',
    '21': '商業地域(特例容積率適用地区)'
};

// 4. アセットタイプごとのアイコン定義
const iconMap = {
    'オフィス': '🏢',
    'レジデンス': '🏠',
    '商業施設': '🛍️',
    'ホテル': '🛏️',
    '物流施設': '🚚'
};

// 5. アセットタイプごとのバッジCSSクラス
const BADGE_CLASSES = {
    'オフィス': 'badge-office',
    'レジデンス': 'badge-residence',
    '商業施設': 'badge-retail',
    'ホテル': 'badge-hotel',
    '物流施設': 'badge-logistics'
};
