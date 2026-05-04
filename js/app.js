import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { POSE_DB } from './pose_db.js';


const PI = Math.PI;

// ════════════════════════════════════════════════════════════
//  48개 포즈 데이터 (Excel 1시트에서 추출)
//  키: L1~L7, R1~R7 (단위: rad)   L_grip/R_grip 기본 0
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
//  Arm Module DB — POSE_DB에서 왼팔/오른팔 자동 분리
// ════════════════════════════════════════════════════════════
// ── Canonical Module helpers ─────────────────────────────────
// canonical = left-arm 기준 { J1..J7 }
// 미러 규칙: J1,J2,J3,J5,J6,J7 부호 반전 / J4(팔꿈치) 부호 유지
function _lToCanon(p)    { return {J1:p.L1,J2:p.L2,J3:p.L3,J4:p.L4,J5:p.L5,J6:p.L6,J7:p.L7}; }
function _rToCanon(p)    { return {J1:-(p.R1||0),J2:-(p.R2||0),J3:-(p.R3||0),J4:(p.R4||0),J5:-(p.R5||0),J6:-(p.R6||0),J7:-(p.R7||0)}; }
function _canonToLeft(j) { return {L1:j.J1,L2:j.J2,L3:j.J3,L4:j.J4,L5:j.J5,L6:j.J6,L7:j.J7}; }
function _canonToRight(j){ return {R1:-j.J1,R2:-j.J2,R3:-j.J3,R4:j.J4,R5:-j.J5,R6:-j.J6,R7:-j.J7}; }
function _canonKey(j)    { return [j.J1,j.J2,j.J3,j.J4,j.J5,j.J6,j.J7].map(v=>Math.round((v||0)*100)/100).join(','); }
function _canonScore(j)  { return 1.5*Math.abs(j.J2)+1.2*Math.abs(j.J1)+0.5*Math.abs(j.J4)+0.3*Math.abs(j.J3); }
function _actLv(j) {
  const sum = Object.values(j).reduce((s,v) => s + Math.abs(v||0), 0);
  return Math.max(1, Math.min(10, Math.ceil(sum / 0.8)));
}

// ── CANON_MODULE_DB : M-001, M-002, ... ─────────────────────
// POSE_DB의 모든 포즈에서 왼팔·오른팔(→ 반전) 후보를 동시 추출,
// 소수점 2자리 기준 dedupe 후 활동량 순 넘버링.
// M-xxx 하나로 왼팔(그대로)·오른팔(반전) 모두 적용 가능.
const CANON_MODULE_DB = {};
(function _buildCanonDB() {
  const _map = {}; // dedup key → { J, sources[] }
  Object.entries(POSE_DB).forEach(([pid, p]) => {
    [[_lToCanon(p), 'L'], [_rToCanon(p), 'R']].forEach(([j, side]) => {
      const key = _canonKey(j);
      const src = `${pid}:${side}`;
      if (_map[key]) { _map[key].sources.push(src); }
      else           { _map[key] = { J: j, sources: [src] }; }
    });
  });
  Object.values(_map)
    .sort((a, b) => _canonScore(a.J) - _canonScore(b.J))
    .forEach((e, i) => {
      const id = `M-${String(i+1).padStart(3,'0')}`;
      CANON_MODULE_DB[id] = { J: e.J, sources: e.sources, activity: _actLv(e.J) };
    });
})();

// 하위 호환 shim — 레거시 경로가 ARM_MODULE_DB를 참조하더라도 동작하도록 유지
const ARM_MODULE_DB = { left: CANON_MODULE_DB, right: CANON_MODULE_DB };

// 생성 포즈 (N-series) 메타 데이터
const CUSTOM_POSE_META = {};   // { 'N-001': { lMod, rMod } }
let editingNPoseId = null;     // 수정 중인 N-포즈 ID

// ════════════════════════════════════════════════════════════
//  동작 구 (Phrase) DB — PH-001 ~
//  poses: 재생할 포즈 ID 배열 / dur: 포즈 1개당 재생 시간(초)
// ════════════════════════════════════════════════════════════
const PHRASE_DB = {
  'PH-001': { name: '웨이브 순방향',    poses: ['P-161','P-162','P-163','P-164','P-165','P-166','P-167','P-168'], dur: 0.65 },
  'PH-002': { name: '웨이브 역방향',    poses: ['P-168','P-167','P-166','P-165','P-164','P-163','P-162','P-161'], dur: 0.65 },
  'PH-003': { name: '만세 올리기',      poses: ['P-435','P-437','P-439','P-441','P-444','P-453','P-458','P-466'], dur: 0.6  },
  'PH-004': { name: '만세 내리기',      poses: ['P-466','P-458','P-453','P-444','P-441','P-439','P-437','P-435'], dur: 0.6  },
  'PH-005': { name: '리듬 바운스',      poses: ['P-041','P-043','P-045','P-047','P-049','P-047','P-045','P-043'], dur: 0.5  },
  'PH-006': { name: 'K-pop 리듬',       poses: ['P-079','P-081','P-083','P-085','P-083','P-081','P-079'], dur: 0.55 },
  'PH-007': { name: '사이드 스웨이',    poses: ['P-071','P-073','P-075','P-077','P-078','P-077','P-075','P-073'], dur: 0.65 },
  'PH-008': { name: '컷 히트',          poses: ['P-089','P-091','P-093','P-095','P-098','P-095','P-093','P-089'], dur: 0.5  },
  'PH-009': { name: '인워드 스윙',      poses: ['P-113','P-115','P-117','P-119','P-117','P-115','P-113'], dur: 0.6  },
  'PH-010': { name: '와이드 스트레치',  poses: ['P-145','P-147','P-149','P-151','P-152','P-151','P-149','P-145'], dur: 0.7  },
  'PH-011': { name: '팔 점진 올리기',   poses: ['P-003','P-004','P-005','P-006','P-007'], dur: 0.7  },
  'PH-012': { name: '팔 점진 내리기',   poses: ['P-007','P-006','P-005','P-004','P-003','P-002'], dur: 0.7  },
};

// 타임라인 모드 & 필수 포즈/동작
let tlMode = 'time';           // 'time' | 'music'
let musicDuration = 0;
let reqPoses = [];             // [poseId, ...]
let reqPhrases = [];           // [phraseId, ...]

// 모듈 선택 상태
let selectedLModule = null;
let selectedRModule = null;
let lModFilter = 0;  // 0=전체, 1=저(1-3), 2=중(4-6), 3=고(7-10)
let rModFilter = 0;
let lastFocusedSide = null; // 방향키 내비게이션용

// ════════════════════════════════════════════════════════════
//  키네마틱 체인 (URDF 기반, Z-up 좌표계)
// ════════════════════════════════════════════════════════════
const CHAIN = [
  { name:'body',     parent:null,     type:'fixed',     xyz:[0,0,0],              rpy:[0,0,0],       axis:null,    joint:null,
    mesh:{file:'body/v10/collision/body_link0_symp.stl',  scale:[0.001,0.001,0.001], offset:[0,0,0]}},
  // 왼팔
  { name:'L0', parent:'body',  type:'fixed',    xyz:[0,0.031,0.698],     rpy:[-PI/2,0,0],   axis:null,  joint:null,
    mesh:{file:'arm/v10/visual/link0.stl', scale:[1,-1,1], offset:[0,0,0]}},
  { name:'L1', parent:'L0',   type:'revolute', xyz:[0,0,0.058],          rpy:[0,0,0],        axis:[0,0,1],  joint:'L1',
    mesh:{file:'arm/v10/visual/link1.stl', scale:[1,-1,1], offset:[0,0,0]}},
  { name:'L2', parent:'L1',   type:'revolute', xyz:[-0.0205,0,0.081],    rpy:[-PI/2,0,0],    axis:[-1,0,0], joint:'L2',
    mesh:{file:'arm/v10/visual/link2.stl', scale:[1,-1,1], offset:[0,0,0]}},
  { name:'L3', parent:'L2',   type:'revolute', xyz:[0.02,0,0.099],       rpy:[0,0,0],        axis:[0,0,1],  joint:'L3',
    mesh:{file:'arm/v10/visual/link3.stl', scale:[1,-1,1], offset:[0,0,0]}},
  { name:'L4', parent:'L3',   type:'revolute', xyz:[0,0.031002,0.14181], rpy:[0,0,0],        axis:[0,1,0],  joint:'L4',
    mesh:{file:'arm/v10/visual/link4.stl', scale:[1,1,1],  offset:[0,0,0]}},
  { name:'L5', parent:'L4',   type:'revolute', xyz:[0,-0.0309,0.126],    rpy:[0,0,0],        axis:[0,0,1],  joint:'L5',
    mesh:{file:'arm/v10/visual/link5.stl', scale:[1,-1,1], offset:[0,0,0]}},
  { name:'L6', parent:'L5',   type:'revolute', xyz:[0.037426,0,0.131],   rpy:[0,0,0],        axis:[1,0,0],  joint:'L6',
    mesh:{file:'arm/v10/visual/link6.stl', scale:[1,-1,1], offset:[0,0,0]}},
  { name:'L7', parent:'L6',   type:'revolute', xyz:[-0.0375,0,0],        rpy:[0,0,0],        axis:[0,-1,0], joint:'L7',
    mesh:{file:'arm/v10/visual/link7.stl', scale:[1,-1,1], offset:[0,0,0]}},
  { name:'L_hand',  parent:'L7', type:'fixed', xyz:[0,0,0.1001], rpy:[0,0,0], axis:null, joint:null,
    mesh:{file:'ee/openarmx_hand/collision/hand.stl', scale:[0.001,0.001,0.001], offset:[0,0,-0.6585]}},
  { name:'L_fR', parent:'L_hand', type:'prismatic', xyz:[0,-0.006,0.015], rpy:[0,0,0], axis:[0,-1,0], joint:'L_grip',
    mesh:{file:'ee/openarmx_hand/collision/finger.stl', scale:[0.001,0.001,0.001], offset:[0,-0.05,-0.673]}},
  { name:'L_fL', parent:'L_hand', type:'prismatic', xyz:[0,0.006,0.015],  rpy:[0,0,0], axis:[0,1,0],  joint:'L_grip',
    mesh:{file:'ee/openarmx_hand/collision/finger.stl', scale:[0.001,-0.001,0.001], offset:[0,0.05,-0.673]}},
  { name:'L_tcp', parent:'L_hand', type:'fixed', xyz:[0,0,0.08], rpy:[0,0,0], axis:null, joint:null, mesh:null },
  // 오른팔
  { name:'R0', parent:'body',  type:'fixed',    xyz:[0,-0.031,0.698],    rpy:[PI/2,0,0],    axis:null,  joint:null,
    mesh:{file:'arm/v10/visual/link0.stl', scale:[1,1,1], offset:[0,0,0]}},
  { name:'R1', parent:'R0',   type:'revolute', xyz:[0,0,0.058],          rpy:[0,0,0],        axis:[0,0,1],  joint:'R1',
    mesh:{file:'arm/v10/visual/link1.stl', scale:[1,1,1], offset:[0,0,0]}},
  { name:'R2', parent:'R1',   type:'revolute', xyz:[-0.0205,0,0.081],    rpy:[PI/2,0,0],     axis:[-1,0,0], joint:'R2',
    mesh:{file:'arm/v10/visual/link2.stl', scale:[1,1,1], offset:[0,0,0]}},
  { name:'R3', parent:'R2',   type:'revolute', xyz:[0.02,0,0.099],       rpy:[0,0,0],        axis:[0,0,1],  joint:'R3',
    mesh:{file:'arm/v10/visual/link3.stl', scale:[1,1,1], offset:[0,0,0]}},
  { name:'R4', parent:'R3',   type:'revolute', xyz:[0,0.031002,0.14181], rpy:[0,0,0],        axis:[0,1,0],  joint:'R4',
    mesh:{file:'arm/v10/visual/link4.stl', scale:[1,1,1], offset:[0,0,0]}},
  { name:'R5', parent:'R4',   type:'revolute', xyz:[0,-0.0309,0.126],    rpy:[0,0,0],        axis:[0,0,1],  joint:'R5',
    mesh:{file:'arm/v10/visual/link5.stl', scale:[1,1,1], offset:[0,0,0]}},
  { name:'R6', parent:'R5',   type:'revolute', xyz:[0.037426,0,0.131],   rpy:[0,0,0],        axis:[1,0,0],  joint:'R6',
    mesh:{file:'arm/v10/visual/link6.stl', scale:[1,1,1], offset:[0,0,0]}},
  { name:'R7', parent:'R6',   type:'revolute', xyz:[-0.0375,0,0],        rpy:[0,0,0],        axis:[0,1,0],  joint:'R7',
    mesh:{file:'arm/v10/visual/link7.stl', scale:[1,1,1], offset:[0,0,0]}},
  { name:'R_hand',  parent:'R7', type:'fixed', xyz:[0,0,0.1001], rpy:[0,0,0], axis:null, joint:null,
    mesh:{file:'ee/openarmx_hand/collision/hand.stl', scale:[0.001,0.001,0.001], offset:[0,0,-0.6585]}},
  { name:'R_fR', parent:'R_hand', type:'prismatic', xyz:[0,-0.006,0.015], rpy:[0,0,0], axis:[0,-1,0], joint:'R_grip',
    mesh:{file:'ee/openarmx_hand/collision/finger.stl', scale:[0.001,0.001,0.001], offset:[0,-0.05,-0.673]}},
  { name:'R_fL', parent:'R_hand', type:'prismatic', xyz:[0,0.006,0.015],  rpy:[0,0,0], axis:[0,1,0],  joint:'R_grip',
    mesh:{file:'ee/openarmx_hand/collision/finger.stl', scale:[0.001,-0.001,0.001], offset:[0,0.05,-0.673]}},
  { name:'R_tcp', parent:'R_hand', type:'fixed', xyz:[0,0,0.08], rpy:[0,0,0], axis:null, joint:null, mesh:null },
];

// 조인트 이름 목록
const JOINT_KEYS = ['L1','L2','L3','L4','L5','L6','L7','L_grip','R1','R2','R3','R4','R5','R6','R7','R_grip'];

// 현재 조인트 각도
let q = { L1:0,L2:0,L3:0.26,L4:0.5,L5:0,L6:0,L7:0,L_grip:0, R1:0,R2:0,R3:-0.26,R4:0.5,R5:0,R6:0,R7:0,R_grip:0 };

// 파싱된 타임라인: [{ time, pose_id, transition_id }]
let allKeyframes = [];
let selectedTID  = null;   // 선택된 transition_id

// ── 재생 전용 캐시 (animate 루프에서 매 프레임 filter+sort 제거) ──
let _playTimeline = [];   // 현재 선택된 TID의 정렬된 키프레임 배열
let _playDur      = 0;    // 총 재생 길이 (시각 바 total과 일치)
let _tlTotalDur   = 0;    // applyTimeline 시 tlRows.duration 합산값 (시각 바 기준)

/** activeTimeline()을 캐시에 반영 — applyTimeline / TID 변경 시 1회만 호출 */
function _rebuildPlayTimeline() {
  if (!selectedTID) { _playTimeline = []; _playDur = 0; return; }
  _playTimeline = allKeyframes
    .filter(k => k.transition_id === selectedTID)
    .sort((a, b) => a.time - b.time);
  // _tlTotalDur가 있으면 시각 바와 동기화, 없으면 마지막 KF 시각 사용
  _playDur = _tlTotalDur || (_playTimeline.length ? _playTimeline[_playTimeline.length - 1].time : 0);
}

function activeTimeline() {
  if (!selectedTID) return [];
  return allKeyframes
    .filter(k => k.transition_id === selectedTID)
    .sort((a, b) => a.time - b.time);
}

// ════════════════════════════════════════════════════════════
//  Three.js 초기화
// ════════════════════════════════════════════════════════════
const viewport = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
viewport.insertBefore(renderer.domElement, document.getElementById('playbar'));

const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a18);
scene.fog = new THREE.FogExp2(0x0a0a18, 0.10);

// ── 배경 컬러 프리셋 ──
const BG_PRESETS = {
  dark:  { bg:'#0a0a18', fog:'#0a0a18', fogD:0.10, grid1:'#223344', grid2:'#111122', light:false },
  navy:  { bg:'#0d1a2e', fog:'#0d1a2e', fogD:0.08, grid1:'#1a3050', grid2:'#0d1a2e', light:false },
  black: { bg:'#000000', fog:'#000000', fogD:0.12, grid1:'#1a1a1a', grid2:'#111111', light:false },
  lgray: { bg:'#b0b8c8', fog:'#b0b8c8', fogD:0.06, grid1:'#7a8898', grid2:'#90a0b0', light:true  },
  white: { bg:'#f0f0f5', fog:'#f0f0f5', fogD:0.04, grid1:'#aaaacc', grid2:'#ccccdd', light:true  },
};

function _applyBg(hex, preset) {
  scene.background.set(hex);
  scene.fog.color.set(hex);
  if (preset) scene.fog.density = preset.fogD;
  if (preset && grid) {
    grid.material[0].color.set(preset.grid1);
    grid.material[1].color.set(preset.grid2);
  }
  document.getElementById('viewport').style.background = hex;
  localStorage.setItem('oax_bg', hex);
}

window.toggleColorPalette = function() {
  document.getElementById('color-palette').classList.toggle('open');
};
// 하위 호환 (구 함수명 참조 방어)
window.toggleBgPalette    = window.toggleColorPalette;
window.toggleSkinPalette  = window.toggleColorPalette;

window.setBgPreset = function(key) {
  const p = BG_PRESETS[key];
  if (!p) return;
  _applyBg(p.bg, p);
  document.querySelectorAll('.cp-swatch[data-bg]').forEach(s => s.classList.toggle('active', s.dataset.bg === key));
  document.getElementById('bg-custom-inp').value = p.bg;
};

window.setBgCustom = function(hex) {
  _applyBg(hex, null);
  document.querySelectorAll('.cp-swatch[data-bg]').forEach(s => s.classList.remove('active'));
};

// ════════════════════════════════════════════════════════════
//  스킨 컬러 선택기
// ════════════════════════════════════════════════════════════
const SKIN_PRESETS = {
  default: { left:'#3a7ae0', right:'#e04030', body:'#4a6080', hand:'#7a8898', jL:'#6aabff', jR:'#ff8866' },
  white:   { left:'#d8d8d8', right:'#d8d8d8', body:'#c0c0c0', hand:'#d0d0d0', jL:'#f0f0f0', jR:'#f0f0f0' },
  black:   { left:'#2a2a2a', right:'#2a2a2a', body:'#333333', hand:'#222222', jL:'#555555', jR:'#555555' },
  green:   { left:'#2a8a40', right:'#8a4020', body:'#3a5030', hand:'#4a5040', jL:'#44cc66', jR:'#cc7744' },
  silver:  { left:'#9aaabb', right:'#9aaabb', body:'#7a8898', hand:'#6a7888', jL:'#c8dae8', jR:'#c8dae8' },
};

// 씬 내 모든 Mesh 색상 재적용 (getMat 기준으로 재매핑)
function _recolorScene() {
  // 순회 1회로 통합: 링크 메시 + 관절 마커를 한 번에 처리
  sceneRoot.traverse(obj => {
    if (!(obj instanceof THREE.Mesh) || !obj.material) return;
    const name = obj.parent && obj.parent.name ? obj.parent.name : '';

    // 관절 구 마커 (SphereGeometry, radius ≤ 0.01)
    const isJoint = obj.geometry && obj.geometry.type === 'SphereGeometry' &&
                    obj.geometry.parameters && obj.geometry.parameters.radius <= 0.01;
    if (isJoint) {
      const src = name.startsWith('L') ? MAT.jL : name.startsWith('R') ? MAT.jR : null;
      if (src) {
        obj.material.color.copy(src.color);
        obj.material.emissive.copy(src.emissive);
        obj.material.needsUpdate = true;
      }
      return; // 관절 마커는 여기서 처리 완료
    }

    // TCP 마커 (SphereGeometry, radius > 0.01) → 색상 유지
    if (obj.geometry && obj.geometry.type === 'SphereGeometry') return;

    // STL 링크 메시
    let target = null;
    if      (name === 'body')                               target = MAT.body;
    else if (name.includes('hand') || name.includes('_f')) target = MAT.hand;
    else if (name.startsWith('L'))                          target = MAT.left;
    else if (name.startsWith('R'))                          target = MAT.right;
    if (target) {
      obj.material.color.copy(target.color);
      obj.material.roughness = target.roughness;
      obj.material.metalness = target.metalness;
      obj.material.needsUpdate = true;
    }
  });
}

// 파트별 MAT 업데이트 + 저장
function _applySkinPart(part, hex) {
  const c = new THREE.Color(hex);
  if (part === 'left')  { MAT.left.color.set(c);  MAT.jL.color.set(hex); MAT.jL.emissive.set(new THREE.Color(hex).multiplyScalar(0.3)); }
  if (part === 'right') { MAT.right.color.set(c); MAT.jR.color.set(hex); MAT.jR.emissive.set(new THREE.Color(hex).multiplyScalar(0.3)); }
  if (part === 'body')  { MAT.body.color.set(c); }
  if (part === 'hand')  { MAT.hand.color.set(c); }
  _recolorScene();
  // localStorage 저장
  const saved = _loadSkinStorage();
  saved[part] = hex;
  localStorage.setItem('oax_skin', JSON.stringify(saved));
}

function _loadSkinStorage() {
  try { return JSON.parse(localStorage.getItem('oax_skin') || '{}'); } catch(e) { return {}; }
}

window.toggleSkinPalette = function() {
  document.getElementById('skin-palette').classList.toggle('open');
};

window.setSkinPreset = function(key) {
  const p = SKIN_PRESETS[key];
  if (!p) return;
  ['left','right','body','hand'].forEach(part => _applySkinPart(part, p[part]));
  const ids = { left:'skin-left-inp', right:'skin-right-inp', body:'skin-body-inp', hand:'skin-hand-inp' };
  Object.entries(ids).forEach(([k,id]) => { const el = document.getElementById(id); if (el) el.value = p[k]; });
  document.querySelectorAll('.cp-swatch[data-skin]').forEach(s => s.classList.toggle('active', s.dataset.skin === key));
  localStorage.setItem('oax_skin', JSON.stringify(p));
};

window.setSkinPart = function(part, hex) {
  _applySkinPart(part, hex);
};

window.setSkinBoth = function(hex) {
  _applySkinPart('left', hex);
  _applySkinPart('right', hex);
  const li = document.getElementById('skin-left-inp');
  const ri = document.getElementById('skin-right-inp');
  if (li) li.value = hex;
  if (ri) ri.value = hex;
};

// 저장된 스킨 복원 (STL 로드 후 호출)
function _restoreSkinStorage() {
  const saved = _loadSkinStorage();
  if (!Object.keys(saved).length) return;
  ['left','right','body','hand'].forEach(part => {
    if (saved[part]) {
      _applySkinPart(part, saved[part]);
      const idMap = { left:'skin-left-inp', right:'skin-right-inp', body:'skin-body-inp', hand:'skin-hand-inp' };
      const el = document.getElementById(idMap[part]);
      if (el) el.value = saved[part];
    }
  });
}

const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 30);
camera.position.set(1.8, 1.2, 2.2);
camera.lookAt(0, 0.5, 0);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.5, 0);
orbit.enableDamping = true; orbit.dampingFactor = 0.06;
orbit.minDistance = 0.3;    orbit.maxDistance = 8;
orbit.update();

// 조명
scene.add(new THREE.AmbientLight(0x304060, 1.3));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(3,5,3); sun.castShadow = true;
sun.shadow.mapSize.set(2048,2048);
Object.assign(sun.shadow.camera, {near:0.1,far:15,left:-2,right:2,top:3,bottom:-1});
scene.add(sun);
const fill = new THREE.DirectionalLight(0x4488ff, 0.4);
fill.position.set(-2,2,-2); scene.add(fill);

const grid = new THREE.GridHelper(4,24,0x223344,0x111122);
scene.add(grid);

// 저장된 배경색 복원
(function() {
  const saved = localStorage.getItem('oax_bg');
  if (saved) {
    // 프리셋 매칭 시도
    const matchKey = Object.keys(BG_PRESETS).find(k => BG_PRESETS[k].bg === saved);
    if (matchKey) setBgPreset(matchKey);
    else setBgCustom(saved);
  }
})();

// 씬 루트 (URDF Z-up → Three.js Y-up)
const sceneRoot = new THREE.Group();
sceneRoot.rotation.x = -PI/2;
scene.add(sceneRoot);

// 재질 — metalness 낮춤으로 선택 색상이 실제로 보이게 조정
const MAT = {
  body:  new THREE.MeshStandardMaterial({color:0x4a6080,roughness:.55,metalness:.25}),
  left:  new THREE.MeshStandardMaterial({color:0x3a7ae0,roughness:.35,metalness:.25}),
  right: new THREE.MeshStandardMaterial({color:0xe04030,roughness:.35,metalness:.25}),
  hand:  new THREE.MeshStandardMaterial({color:0x7a8898,roughness:.45,metalness:.20}),
  jL:    new THREE.MeshStandardMaterial({color:0x6aabff,roughness:.25,metalness:.35,emissive:0x112244}),
  jR:    new THREE.MeshStandardMaterial({color:0xff8866,roughness:.25,metalness:.35,emissive:0x441122}),
  tcp:   new THREE.MeshStandardMaterial({color:0x00ff88,emissive:0x00aa44,emissiveIntensity:.9,roughness:.1}),
};

function getMat(name) {
  if (name.includes('hand') || name.includes('_f')) return MAT.hand.clone();
  if (name === 'body') return MAT.body.clone();
  if (name.startsWith('L')) return MAT.left.clone();
  if (name.startsWith('R')) return MAT.right.clone();
  return MAT.body.clone();
}

// 씬 그래프 구축
const groups = {};
CHAIN.forEach(lk => { groups[lk.name] = new THREE.Group(); groups[lk.name].name = lk.name; });
CHAIN.forEach(lk => {
  const par = lk.parent ? groups[lk.parent] : sceneRoot;
  par.add(groups[lk.name]);
});

// TCP 마커
const tcpGeo = new THREE.SphereGeometry(0.013, 8, 8);
['L_tcp','R_tcp'].forEach(n => groups[n].add(new THREE.Mesh(tcpGeo, MAT.tcp.clone())));

// 조인트 마커
const jGeo = new THREE.SphereGeometry(0.007, 6, 6);
CHAIN.filter(lk => lk.type === 'revolute').forEach(lk => {
  const mat = lk.name.startsWith('L') ? MAT.jL.clone() : MAT.jR.clone();
  groups[lk.name].add(new THREE.Mesh(jGeo, mat));
});

// STL 로드
const stlLoader = new STLLoader();
let loaded = 0, total = 0;

CHAIN.forEach(lk => {
  if (!lk.mesh) return;
  total++;
  stlLoader.load(`meshes/${lk.mesh.file}`, geo => {
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, getMat(lk.name));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.scale.set(...lk.mesh.scale);
    mesh.position.set(...lk.mesh.offset);
    groups[lk.name].add(mesh);
    loaded++;
    if (loaded === total) { setStatus('준비 완료 ✓'); _restoreSkinStorage(); }
    else setStatus(`메시 로딩 ${loaded}/${total}`);
  }, undefined, () => { loaded++; });
});

// ════════════════════════════════════════════════════════════
//  순방향 기구학 (FK)
// ════════════════════════════════════════════════════════════
function updateFK(angles) {
  CHAIN.forEach(lk => {
    const g = groups[lk.name];
    const [x,y,z] = lk.xyz, [r,p,yw] = lk.rpy;
    const qO = new THREE.Quaternion().setFromEuler(new THREE.Euler(r,p,yw,'XYZ'));

    if (lk.type === 'revolute' && lk.joint && angles[lk.joint] !== undefined) {
      const ax = new THREE.Vector3(...lk.axis).normalize();
      const qJ = new THREE.Quaternion().setFromAxisAngle(ax, angles[lk.joint]);
      g.quaternion.copy(qO).multiply(qJ);
      g.position.set(x,y,z);
    } else if (lk.type === 'prismatic' && lk.joint && angles[lk.joint] !== undefined) {
      const d = angles[lk.joint];
      g.position.set(x + lk.axis[0]*d, y + lk.axis[1]*d, z + lk.axis[2]*d);
      g.quaternion.copy(qO);
    } else {
      g.position.set(x,y,z); g.quaternion.copy(qO);
    }
  });
}

function poseToAngles(poseId) {
  const p = POSE_DB[poseId];
  if (!p) {
    // N-포즈가 POSE_DB에 없으면 allKeyframes 적용 전 페이지 상태 불일치
    console.warn('[poseToAngles] 포즈를 찾을 수 없음:', poseId,
      '— POSE_IDS에 포함 여부:', POSE_IDS.includes(poseId));
    return null;
  }
  return { ...p, L_grip:0, R_grip:0 };
}

// ════════════════════════════════════════════════════════════
//  인터폴레이션
// ════════════════════════════════════════════════════════════
function smoothStep(t) { return t*t*(3-2*t); }

/** tl: 미리 계산된 타임라인(선택). 생략 시 activeTimeline() 호출 */
function interpolate(t, tl) {
  if (!tl) tl = activeTimeline();
  if (!tl.length) return { ...q };
  if (tl.length === 1) {
    const p0 = poseToAngles(tl[0].pose_id);
    if (!p0) { console.warn('[interpolate] pose 없음:', tl[0].pose_id); return { ...q }; }
    return p0;
  }

  let before = tl[0], after = tl[tl.length-1];
  for (let i=0; i<tl.length-1; i++) {
    if (tl[i].time <= t && tl[i+1].time >= t) { before=tl[i]; after=tl[i+1]; break; }
  }
  if (before.time === after.time) {
    const p0 = poseToAngles(before.pose_id);
    if (!p0) { console.warn('[interpolate] pose 없음:', before.pose_id); return { ...q }; }
    return p0;
  }

  const alpha = (t - before.time) / (after.time - before.time);
  const s     = smoothStep(Math.max(0, Math.min(1, alpha)));
  const p1    = poseToAngles(before.pose_id);
  const p2    = poseToAngles(after.pose_id);

  if (!p1) { console.warn('[interpolate] before pose 없음:', before.pose_id); }
  if (!p2) { console.warn('[interpolate] after pose 없음:', after.pose_id); }

  const src1 = p1 || q;
  const src2 = p2 || q;

  const out = {};
  JOINT_KEYS.forEach(k => {
    const v1 = isFinite(src1[k]) ? src1[k] : 0;
    const v2 = isFinite(src2[k]) ? src2[k] : 0;
    out[k] = v1 + (v2 - v1) * s;
  });
  return out;
}

// 현재 시간에서 가장 가까운 pose_id 찾기 (tl: 선택적 사전계산 타임라인)
function nearestPoseId(t, tl) {
  if (!tl) tl = activeTimeline();
  if (!tl.length) return '-';
  let best = tl[0];
  for (const kf of tl) { if (kf.time <= t) best = kf; else break; }
  return best.pose_id;
}

// ════════════════════════════════════════════════════════════
//  애니메이션 제어
// ════════════════════════════════════════════════════════════
let isPlaying = false, isLooping = true;
let startWall = 0, pauseOffset = 0;
const scrubber = document.getElementById('scrubber');
const bgAudio  = document.getElementById('bg-audio');
let musicBlobUrl = null;

function totalDur() {
  const tl = activeTimeline();
  return tl.length ? tl[tl.length-1].time : 0;
}

function _audioPlay(t) {
  if (!musicBlobUrl) return;
  bgAudio.currentTime = Math.min(t, bgAudio.duration || Infinity);
  bgAudio.play().catch(() => {});
}
function _audioPause() { if (!bgAudio.paused) bgAudio.pause(); }
function _audioStop()  { bgAudio.pause(); bgAudio.currentTime = 0; }
function _audioSeek(t) { if (musicBlobUrl && isFinite(bgAudio.duration)) bgAudio.currentTime = Math.min(t, bgAudio.duration); }

window.playAnim = function() {
  if (!activeTimeline().length) { alert('타임라인에서 포즈를 추가하고 [✓ 적용 & 재생]을 눌러주세요.'); return; }
  startWall = performance.now() - pauseOffset * 1000;
  isPlaying = true;
  _syncPlayBtns();
  _audioPlay(pauseOffset);
};
window.pauseAnim = function() {
  if (!isPlaying) return;
  pauseOffset = (performance.now() - startWall) / 1000;
  const d = totalDur();
  if (d>0) pauseOffset %= d;
  isPlaying = false;
  _syncPlayBtns();
  _audioPause();
};
window.stopAnim = function() {
  isPlaying = false; pauseOffset = 0;
  _syncPlayBtns();
  scrubber.value = 0;
  updateTimeLbl(0);
  updateFK(q);
  _audioStop();
  _updateTLPlayhead(0, parseFloat(scrubber.max) || 1);
  _lastKFHighlight = -1;
  document.querySelectorAll('.tl-seg').forEach(s => s.classList.remove('seg-active'));
  document.querySelectorAll('.tl-row').forEach(r => r.classList.remove('preview'));
};
window.toggleLoop = function() {
  isLooping = !isLooping;
  _syncPlayBtns();
};

scrubber.addEventListener('input', () => {
  const t = parseFloat(scrubber.value);
  pauseOffset = t;
  const tl  = _playTimeline.length ? _playTimeline : activeTimeline();
  const ang = interpolate(t, tl);
  // NaN 방어 적용 후 q 갱신
  const safe = {};
  JOINT_KEYS.forEach(k => { safe[k] = isFinite(ang[k]) ? ang[k] : (isFinite(q[k]) ? q[k] : 0); });
  Object.assign(q, safe);
  updateFK(safe);
  updateTimeLbl(t);
  document.getElementById('cur-pose-id').textContent = nearestPoseId(t, tl);
  highlightKFRow(t, tl);
  _updateTLPlayhead(t, parseFloat(scrubber.max) || 0);
  _audioSeek(t);
});

function updateTimeLbl(t) {
  const d = totalDur();
  const txt = `${t.toFixed(2)} / ${d.toFixed(1)} s`;
  document.getElementById('time-lbl').textContent = txt;
  const sd = document.getElementById('tl-time-disp');
  if (sd) sd.textContent = txt;
}

// 재생 버튼 상태 동기화 (playbar)
function _syncPlayBtns() {
  document.getElementById('btn-play')?.classList.toggle('on', isPlaying);
  document.getElementById('btn-pause')?.classList.toggle('on', !isPlaying && pauseOffset > 0);
  document.getElementById('btn-loop')?.classList.toggle('on', isLooping);
}

// 클릭한 x 위치 → 시간으로 변환해 탐색
window.seekToTime = function(t) {
  const tl = _playTimeline.length ? _playTimeline : activeTimeline();
  if (!tl.length) return;
  const d = _playDur || totalDur();
  if (!d) return;
  t = Math.max(0, Math.min(t, d));
  pauseOffset = t;
  scrubber.value = t;
  const ang = interpolate(t, tl);
  const safe = {};
  JOINT_KEYS.forEach(k => { safe[k] = isFinite(ang[k]) ? ang[k] : (isFinite(q[k]) ? q[k] : 0); });
  Object.assign(q, safe);
  updateFK(safe);
  updateTimeLbl(t);
  document.getElementById('cur-pose-id').textContent = nearestPoseId(t, tl);
  highlightKFRow(t, tl);
  _updateTLPlayhead(t, d);
  _audioSeek(t);
};

// ════════════════════════════════════════════════════════════
//  녹화
// ════════════════════════════════════════════════════════════
let mediaRecorder = null, chunks = [];

window.startRec = function() {
  const stream = renderer.domElement.captureStream(30);
  mediaRecorder = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp9'});
  chunks = [];
  mediaRecorder.ondataavailable = e => { if(e.data.size>0) chunks.push(e.data); };
  mediaRecorder.start();
  document.getElementById('rec-badge').style.display = 'block';
  document.getElementById('btn-rec').classList.add('on');
  stopAnim(); playAnim();
  setStatus('녹화 중...');
};
window.stopRec = function() {
  if (!mediaRecorder) { alert('먼저 ● 녹화를 누르세요'); return; }
  mediaRecorder.stop();
  mediaRecorder.onstop = () => {
    const blob = new Blob(chunks, {type:'video/webm'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'openarmx_sim.webm';
    a.click();
    document.getElementById('rec-badge').style.display = 'none';
    document.getElementById('btn-rec').classList.remove('on');
    setStatus('저장 완료 ✓');
  };
};

// ════════════════════════════════════════════════════════════
//  JSON 타임라인 파싱 & 적용
// ════════════════════════════════════════════════════════════
// ── 타임라인 행 에디터 데이터 ──
let tlRows = []; // [{pose_id, duration}]
let _dragIdx = null; // 드래그 중인 행 인덱스

// 적용 버튼 활성/비활성
function _setApplyBtnActive(active) {
  const btn = document.getElementById('tl-apply-btn');
  if (!btn) return;
  btn.disabled = !active;
  btn.style.opacity = active ? '' : '0.38';
  btn.title = active ? '' : '생성하기 또는 음악 파일을 추가하면 활성화됩니다';
}

const POSE_IDS = Object.keys(POSE_DB); // P-001 ~ P-168

// 옵션 HTML을 한 번만 빌드하고 캐시 (POSE_IDS 변경 시 무효화)
let _tlOptsCache = null;
let _tlOptsCachedCount = 0;   // 포즈 개수 기준으로 비교 (문자열 길이 아님)
function _getTLOptsHtml() {
  if (!_tlOptsCache || _tlOptsCachedCount !== POSE_IDS.length) {
    _tlOptsCache = POSE_IDS.map(id => `<option value="${id}">${id}</option>`).join('');
    _tlOptsCachedCount = POSE_IDS.length;
  }
  return _tlOptsCache;
}
// 캐시 무효화
function _invalidateTLCache() { _tlOptsCache = null; _tlOptsCachedCount = 0; }

// 기존 select들에 새 포즈 옵션만 추가 (전체 재빌드 없이)
function _appendPoseOptToSelects(id) {
  document.querySelectorAll('.tl-pose-sel').forEach(sel => {
    if (!sel.querySelector(`option[value="${id}"]`)) {
      const opt = document.createElement('option');
      opt.value = opt.textContent = id;
      sel.appendChild(opt);
    }
  });
}
// 삭제된 포즈 옵션 제거
function _removePoseOptFromSelects(id) {
  document.querySelectorAll('.tl-pose-sel').forEach(sel => {
    if (sel.value === id) sel.value = POSE_IDS.find(p => !p.startsWith('N-')) || 'P-001';
    sel.querySelector(`option[value="${id}"]`)?.remove();
  });
}

function renderTLRows() {
  const container = document.getElementById('tl-rows');
  const frag = document.createDocumentFragment();
  const optsHtml = _getTLOptsHtml();

  let cumSec = 0;
  tlRows.forEach((row, i) => {
    const startSec = cumSec;
    cumSec = +(cumSec + row.duration).toFixed(1);

    const div = document.createElement('div');

    // ── 동작 구(phrase) 행 ──────────────────────────────────
    if (row._type === 'phrase') {
      div.className = 'tl-row tl-row-phrase';
      div.innerHTML = `
        <span class="tl-handle" title="드래그로 순서 변경">⠿</span>
        <span class="tl-phrase-name">🎬 ${row.name}</span>
        <span class="tl-phrase-meta">${row.poses.length}포즈 · ${row.duration.toFixed(1)}s</span>
        <span class="tl-phrase-lock" title="재생 시간 보장 — 이 블록은 압축되지 않습니다">🔒</span>
        <button class="tl-btn" style="color:#a44;" onclick="delTLRow(${i})" title="삭제">✕</button>
      `;
      div.addEventListener('click', e => {
        if (e.target.closest('button,span.tl-handle')) return;
        previewTLRow(i);
      });

    // ── 일반 포즈 행 ─────────────────────────────────────────
    } else {
    div.className = 'tl-row';
    div.innerHTML = `
      <span class="tl-handle" title="드래그로 순서 변경">⠿</span>
      <select class="tl-pose-sel" onchange="tlRows[${i}].pose_id=this.value;updateTLTotal();renderTLVisBar()">${optsHtml}</select>
      <input class="tl-dur-inp" type="number" min="0.1" max="30" step="0.1" value="${row.duration}"
        onchange="tlRows[${i}].duration=+parseFloat(this.value).toFixed(1);renderTLRows()">
      <span class="tl-cum" title="시작 시각">${startSec.toFixed(1)}s</span>
      <button class="tl-btn" style="color:#a44;" onclick="delTLRow(${i})" title="삭제">✕</button>
    `;

    // 행 클릭 → 포즈 미리보기 (컨트롤 클릭 제외)
    div.addEventListener('click', e => {
      if (e.target.closest('select,input,button,span.tl-handle')) return;
      previewTLRow(i);
    });
    } // end else

    // ── 드래그&드롭 순서 변경 ──
    const handle = div.querySelector('.tl-handle');
    handle.draggable = true;

    handle.addEventListener('dragstart', e => {
      _dragIdx = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
      setTimeout(() => div.classList.add('dragging'), 0);
    });
    handle.addEventListener('dragend', () => {
      div.classList.remove('dragging');
      document.querySelectorAll('.tl-row').forEach(r => r.classList.remove('drag-over'));
      _dragIdx = null;
    });
    div.addEventListener('dragover', e => {
      if (_dragIdx === null || _dragIdx === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.tl-row').forEach(r => r.classList.remove('drag-over'));
      div.classList.add('drag-over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault();
      div.classList.remove('drag-over');
      if (_dragIdx === null || _dragIdx === i) return;
      const moved = tlRows.splice(_dragIdx, 1)[0];
      tlRows.splice(i, 0, moved);
      _dragIdx = null;
      renderTLRows();
    });

    const sel = div.querySelector('.tl-pose-sel');
    if (sel && POSE_IDS.includes(row.pose_id)) sel.value = row.pose_id;
    frag.appendChild(div);
  });

  container.innerHTML = '';
  container.appendChild(frag);
  updateTLTotal();
  renderTLVisBar();
}

// ────────────────────────────────────────────────────────────
//  비주얼 타임라인 바 렌더링
// ────────────────────────────────────────────────────────────
const _P_COLORS = ['#1a3a7a','#1e4a9a','#15345a','#1d3f6e','#162f62','#183472'];
const _N_COLORS = ['#0d4a2a','#0f5530','#0b4025','#124d2e','#0e4628','#0c4224'];

function renderTLVisBar() {
  const track = document.getElementById('tl-track');
  const ruler = document.getElementById('tl-ruler');
  if (!track || !ruler) return;

  const total = +tlRows.reduce((s, r) => s + r.duration, 0).toFixed(2);
  if (!total || !tlRows.length) {
    track.innerHTML = '<div id="tl-playhead" style="left:0%"></div>';
    ruler.innerHTML = '';
    return;
  }

  // 눈금 간격 자동 계산
  const step = total <= 10 ? 2 : total <= 30 ? 5 : total <= 60 ? 10 : 15;
  let rulerHtml = '';
  for (let s = 0; s <= total + 0.001; s += step) {
    if (s > total) s = total;
    const pct = (s / total) * 100;
    rulerHtml += `<span class="tl-ruler-mark" style="left:${pct.toFixed(2)}%">${s.toFixed(0)}s</span>`;
    if (s >= total) break;
  }
  ruler.innerHTML = rulerHtml;

  let trackHtml = '';
  let cumSec = 0;
  const _PH_COLORS = ['#4a1a80','#5a2090','#3d1570','#521e8a'];
  tlRows.forEach((row, i) => {
    const startSec = cumSec;
    cumSec = +(cumSec + row.duration).toFixed(2);
    const widthPct = (row.duration / total) * 100;

    if (row._type === 'phrase') {
      // ── 동작 구 세그먼트 ──
      const bg = _PH_COLORS[i % _PH_COLORS.length];
      const showLabel = widthPct > 5;
      const showDur   = widthPct > 10;
      trackHtml += `<div class="tl-seg tl-seg-phrase" style="width:${widthPct.toFixed(3)}%;background:${bg};"
        data-idx="${i}" onclick="previewTLRow(${i})"
        title="🎬 ${row.name}  ·  ${row.poses.length}포즈  ·  ${row.duration.toFixed(1)}s (보장)  @  ${startSec.toFixed(1)}s">
        ${showLabel ? `<span class="tl-seg-id">🎬 ${row.name}</span>` : ''}
        ${showDur   ? `<span class="tl-seg-dur">🔒${row.duration.toFixed(1)}s</span>` : ''}
      </div>`;
    } else {
      // ── 일반 포즈 세그먼트 ──
      const isN = row.pose_id.startsWith('N-');
      const bg = isN ? _N_COLORS[i % _N_COLORS.length] : _P_COLORS[i % _P_COLORS.length];
      const showId  = widthPct > 4;
      const showDur = widthPct > 8;
      trackHtml += `<div class="tl-seg" style="width:${widthPct.toFixed(3)}%;background:${bg};"
        data-idx="${i}" onclick="previewTLRow(${i})"
        title="${row.pose_id}  ·  ${row.duration}s  @  ${startSec.toFixed(1)}s">
        ${showId  ? `<span class="tl-seg-id">${row.pose_id}</span>` : ''}
        ${showDur ? `<span class="tl-seg-dur">${row.duration}s</span>` : ''}
      </div>`;
    }
  });

  trackHtml += '<div id="tl-playhead" style="left:0%"></div>';
  track.innerHTML = trackHtml;

  // 트랙 클릭 → 해당 시간으로 탐색
  track.onclick = e => {
    const rect = track.getBoundingClientRect();
    const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekToTime(pct * total);
    // 클릭한 세그먼트 인덱스 찾아 미리보기 (세그먼트 영역 클릭 시)
    const seg = e.target.closest('.tl-seg');
    if (seg) {
      const idx = parseInt(seg.dataset.idx);
      if (!isNaN(idx)) previewTLRow(idx);
    }
  };
}

// 비주얼 바 플레이헤드 위치 갱신
function _updateTLPlayhead(t, d) {
  const ph = document.getElementById('tl-playhead');
  if (ph && d > 0) ph.style.left = Math.min(100, (t / d) * 100).toFixed(2) + '%';
}

// 특정 행 미리보기 (편집 행 & 비주얼 바 세그먼트 클릭 공통 처리)
window.previewTLRow = function(i) {
  const row = tlRows[i];
  if (!row) return;
  // 구 블록이면 첫 번째 포즈 미리보기
  const pid = row._type === 'phrase' ? row.poses[0] : row.pose_id;
  previewPose(pid);
  // 비주얼 바 하이라이트
  document.querySelectorAll('.tl-seg').forEach((s, j) =>
    s.classList.toggle('seg-active', j === i));
  // 편집 행 하이라이트
  document.querySelectorAll('.tl-row').forEach((r, j) =>
    r.classList.toggle('preview', j === i));
};

function updateTLTotal() {
  const totalPoses = tlRows.reduce((s, r) => s + (r._type === 'phrase' ? r.poses.length : 1), 0);
  const totalSec   = tlRows.reduce((s, r) => s + r.duration, 0);
  const phCount    = tlRows.filter(r => r._type === 'phrase').length;
  const el = document.getElementById('tl-total');
  if (el) el.textContent = `총 ${totalPoses}개 포즈${phCount ? ` (구 ${phCount}개 포함)` : ''} · ${totalSec.toFixed(1)}초`;
}

window.addTLRow = function(poseId = 'P-001', duration = 0.5) {
  tlRows.push({ pose_id: poseId, duration });
  renderTLRows();
};

window.delTLRow = function(i) {
  tlRows.splice(i, 1);
  renderTLRows();
};

window.moveTLRow = function(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= tlRows.length) return;
  [tlRows[i], tlRows[j]] = [tlRows[j], tlRows[i]];
  renderTLRows();
};

window.clearTL = function() {
  tlRows = [];
  _tlTotalDur = 0;
  renderTLRows();
};

function tlRowsToKFs() {
  let t = 0;
  const kfs = [];
  tlRows.forEach(row => {
    if (row._type === 'phrase') {
      // 구 블록: 반올림 누적 오차 방지 → phraseStart 기준 절대 계산
      const phraseStart = t;
      row.poses.forEach((pid, j) => {
        const kfTime = +(phraseStart + j * row.dur).toFixed(2);
        kfs.push({ time: kfTime, pose_id: pid, transition_id: '1' });
      });
      // t는 row.duration만큼 정확히 전진 (누적 오차 없음)
      t = +(phraseStart + row.duration).toFixed(2);
    } else {
      kfs.push({ time: +t.toFixed(2), pose_id: row.pose_id, transition_id: '1' });
      t = +(t + row.duration).toFixed(2);
    }
  });
  return kfs;
}

window.applyTimeline = function() {
  if (!tlRows.length) { alert('포즈를 추가하세요.'); return; }

  // ── 포즈 존재 여부 사전 검증 (N-포즈 + 구 블록 내부 포즈 포함) ──
  const missingPoses = tlRows.flatMap(r =>
    r._type === 'phrase'
      ? r.poses.filter(pid => !POSE_DB[pid])
      : (!POSE_DB[r.pose_id] ? [r.pose_id] : [])
  );
  if (missingPoses.length) {
    const names = [...new Set(missingPoses)].join(', ');
    alert(`아래 포즈가 POSE_DB에 없습니다. 타임라인에서 제거하거나 다시 생성하세요.\n\n${names}`);
    return;
  }

  const btn = document.querySelector('.apply-btn[onclick*="applyTimeline"]');

  function _execute() {
    const kfs = tlRowsToKFs();
    allKeyframes = kfs;
    const tids = ['1'];
    selectedTID = '1';
    // tlRows duration 합산 → 시각 바와 재생 길이 동기화
    _tlTotalDur = +tlRows.reduce((s, r) => s + r.duration, 0).toFixed(2);
    _rebuildPlayTimeline();   // ← _tlTotalDur 기반으로 _playDur 설정
    renderTIDChips(tids);
    renderKFList();
    const d = _playDur;       // ← tlRows 합산과 동일
    scrubber.max = d;
    stopAnim();
    switchTab('timeline');
    setStatus(`적용됨 — ${kfs.length}개 포즈, ${d.toFixed(1)}s`);
    if (isLooping) { isLooping = false; _syncPlayBtns(); }
    if (btn) { btn.textContent = '✓ 적용 & 재생'; btn.disabled = false; btn.style.opacity = ''; }
    _setApplyBtnActive(false);
    playAnim();
  }

  // 음악이 연결돼 있고 아직 로딩 중이면 대기
  if (musicBlobUrl && bgAudio.readyState < 3) {
    if (btn) {
      btn.textContent = '⏳ 음악 로딩 중...';
      btn.disabled = true;
      btn.style.opacity = '0.7';
    }
    setStatus('음악 파일 로딩 중...');
    const onReady = () => { bgAudio.removeEventListener('canplaythrough', onReady); _execute(); };
    bgAudio.addEventListener('canplaythrough', onReady);
    // 5초 후 강제 진행 (느린 환경 대비)
    setTimeout(() => {
      if (btn && btn.disabled) {
        bgAudio.removeEventListener('canplaythrough', onReady);
        _execute();
      }
    }, 5000);
  } else {
    _execute();
  }
};

// 하위 호환: 기존 applyJSON 유지 (내부용)
window.applyJSON = window.applyTimeline;

// ════════════════════════════════════════════════════════════
//  규칙 기반 댄스 시퀀스 생성기
// ════════════════════════════════════════════════════════════
function buildDanceSequence(N) {
  function range(a, b) { return Array.from({length: b-a+1}, (_,i) => a+i); }
  function pid(n) { return `P-${String(n).padStart(3,'0')}`; }
  function pick(arr) { return arr[Math.floor(Math.random()*arr.length)]; }
  function rf(mn, mx) { return +((mn + Math.random()*(mx-mn)).toFixed(1)); }

  const G = {
    basic:    [1,2],
    kpop:     [...range(49,60),...range(79,84)],
    side:     range(61,78),
    guard:    range(85,92),
    hit:      range(93,102),
    cut:      range(103,112),
    inward:   range(113,120),
    onearm:   range(121,124),
    dynamic:  range(125,136),
    close:    range(137,144),
    wide:     range(145,152),
    extreme:  range(161,168),
    highrise: range(435,466),   // 고각 만세/슈퍼맨 포즈 (L1/R1 ±3 이내)
  };
  // POSE_DB에 추가된 모든 포즈가 자동으로 포함되도록 동적 extra 풀 구성
  // → 앞으로 pose_db.js에 커밋하면 별도 수정 없이 생성에 반영됨
  {
    const _covered = new Set(Object.values(G).flat());
    G.extra = Object.keys(POSE_DB)
      .map(k => parseInt(k.slice(2)))
      .filter(n => !_covered.has(n) && n > 2);
  }
  const CAUTION = new Set([52,53,87,90,91,92,94,95,98,99,101,103,104,105,107,108,111,114,115,116,117,118,119,140,143,162,163,164,165,166,167]);
  const BUFFER  = [2,43,64,71,102,120,126,145,161,168];
  const WAVE_FWD = [161,162,163,164,165,166,167,168];
  const WAVE_BWD = [161,167,166,165,164,163,162,168];

  const kfs = [];
  let t = 0.0;

  function add(n) { kfs.push({transition_id:'1', time:+t.toFixed(1), pose_id:pid(n)}); }
  function step(n, iv) { add(n); t = +(t + iv).toFixed(1); }

  function consecCaution() {
    let c = 0;
    for (let i = kfs.length-1; i >= 0 && CAUTION.has(parseInt(kfs[i].pose_id.slice(2))); i--) c++;
    return c;
  }
  function safe(pool) {
    if (consecCaution() >= 2) {
      const s = pool.filter(p => !CAUTION.has(p));
      return s.length ? pick(s) : pick(BUFFER);
    }
    return pick(pool);
  }
  function inGroup(p, ...groups) { return groups.some(g => G[g] && G[g].includes(p)); }

  const returnTime = +(N - 0.9).toFixed(1);

  // ── 시작 ──
  step(1, rf(0.4, 0.6));

  // ── Section 1 (0~20%): 워밍업 ──
  const t1 = +(N * 0.20).toFixed(1);
  while (t < t1) {
    const p = safe([...G.kpop, ...G.side, ...G.wide, ...G.extra]);
    const iv = rf(0.4, 0.6);
    step(p, iv);
  }

  // ── Section 2 (20~45%): 리듬 + 비대칭 ──
  const t2 = +(N * 0.45).toFixed(1);
  const pools2 = [G.kpop, G.guard, G.hit, G.onearm, G.side, G.extra];
  while (t < t2) {
    const pool = pick(pools2);
    const p = safe(pool);
    step(p, rf(0.4, 0.65));
    if (inGroup(p,'guard','onearm') && t < t2 && Math.random() > 0.55) {
      step(pick(BUFFER), rf(0.4, 0.5));
    }
  }

  // ── Section 3 (45~65%): 웨이브 + 팝 + 컷 ──
  const t3 = +(N * 0.65).toFixed(1);
  const waveSeq = Math.random() > 0.5 ? WAVE_FWD : WAVE_BWD;
  for (const wp of waveSeq) {
    if (t >= t3 - 0.5 || t >= returnTime - 2.5) break;
    step(wp, rf(0.45, 0.55));
  }
  while (t < t3) {
    const pool = [...G.hit, ...G.cut, ...G.wide, ...G.extra];
    const p = safe(pool);
    step(p, rf(0.4, 0.65));
    if (inGroup(p,'cut') && t < t3 && Math.random() > 0.5) {
      step(pick([161,168,102,120]), rf(0.4, 0.5));
    }
  }

  // ── Section 4 (65~85%): 큰 액션 ──
  const t4 = +(N * 0.85).toFixed(1);
  const pools4 = [G.dynamic, G.close, [...G.wide, 161, 168], G.highrise, G.extra];
  while (t < t4) {
    const pool = pick(pools4);
    const p = safe(pool);
    step(p, rf(0.55, 0.8));
    if (inGroup(p,'dynamic','close') && t < t4 && Math.random() > 0.5) {
      step(pick(BUFFER), rf(0.4, 0.5));
    }
  }

  // ── Section 5 (85~100%): 피날레 ──
  const safeFinale = [...G.kpop, ...G.wide, 161, 168, ...G.highrise, ...G.extra].filter(p => !CAUTION.has(p));
  while (t < returnTime - 0.5) {
    step(safe(safeFinale), rf(0.4, 0.6));
  }

  // ── 복귀 ──
  t = returnTime;
  add(2);
  t = +(returnTime + 0.5).toFixed(1);
  add(1);
  t = +N.toFixed(1);
  add(1);

  return kfs;
}

window.generateDance = function() {
  const statusEl = document.getElementById('gen-status');
  let duration;
  if (tlMode === 'music') {
    if (!musicDuration) { statusEl.textContent = '⚠ 음악 파일을 먼저 선택하세요.'; return; }
    duration = musicDuration;
  } else {
    duration = parseFloat(document.getElementById('gen-duration').value);
    if (!duration || duration < 5) { statusEl.textContent = '⚠ 5초 이상의 시간을 입력하세요.'; return; }
  }

  const timeline = buildDanceSequence(duration);
  // JSON → 행 에디터로 변환
  tlRows = [];

  // ── Step 1: 기본 타임라인 → tlRows (time 기반 duration 계산)
  for (let i = 0; i < timeline.length; i++) {
    const dur = i < timeline.length - 1
      ? +((timeline[i+1].time - timeline[i].time).toFixed(1))
      : 0.5;
    tlRows.push({ pose_id: timeline[i].pose_id, duration: Math.max(0.1, Math.min(0.8, dur)) });
  }

  // ── Step 2: 필수 포즈(reqPoses) 삽입
  if (reqPoses.length) {
    const step = Math.max(2, Math.floor(tlRows.length / (reqPoses.length + 1)));
    reqPoses.forEach((pid, i) => {
      const idx = Math.min(step * (i + 1) + i, tlRows.length - 2);
      tlRows.splice(idx, 0, { pose_id: pid, duration: 0.5 });
    });
  }

  // ── Step 2.5: 필수 동작 구(reqPhrases) 삽입 ──
  if (reqPhrases.length) {
    const step = Math.max(4, Math.floor(tlRows.length / (reqPhrases.length + 1)));
    reqPhrases.forEach((phId, i) => {
      const ph = PHRASE_DB[phId];
      if (!ph) return;
      const totalDur = +(ph.poses.length * ph.dur).toFixed(1);
      const idx = Math.min(step * (i + 1) + i, tlRows.length - 3);
      tlRows.splice(idx, 0, {
        _type: 'phrase', phrase_id: phId, name: ph.name,
        poses: ph.poses, dur: ph.dur, duration: totalDur
      });
    });
  }

  // ── Step 3: 생성 포즈(N-series) 랜덤 삽입
  const nIds = Object.keys(CUSTOM_POSE_META);
  if (nIds.length) {
    const slots = [];
    for (let i = 2; i < tlRows.length - 3; i++) {
      if (Math.random() < 0.20) slots.push(i + slots.length);
    }
    slots.forEach(idx => {
      const pid = nIds[Math.floor(Math.random() * nIds.length)];
      tlRows.splice(idx, 0, { pose_id: pid, duration: 0.5 });
    });
  }

  // ── Step 4: 총 길이를 목표 duration 초에 정확히 맞추기 ──
  // 구 블록(phrase)은 고정 길이라 제외, 일반 포즈 행만 조정
  (function normaliseDuration() {
    const GUARD_HEAD = 2;
    const GUARD_TAIL = 3;
    // phrase 행은 포즈 단위가 정해져 있어 duration 변경 불가 → 제외
    const mid = tlRows.slice(GUARD_HEAD, tlRows.length - GUARD_TAIL)
                      .filter(r => r._type !== 'phrase');
    if (!mid.length) return;

    let surplus = +(tlRows.reduce((s, r) => s + r.duration, 0) - duration).toFixed(2);

    for (let pass = 0; pass < 3 && Math.abs(surplus) > 0.05; pass++) {
      if (surplus > 0) {
        for (let i = 0; i < mid.length && surplus > 0.01; i++) {
          const cut = Math.min(
            +((surplus / (mid.length - i)).toFixed(2)),
            +(mid[i].duration - 0.1).toFixed(2)
          );
          if (cut > 0.01) {
            mid[i].duration = Math.max(0.1, +(mid[i].duration - cut).toFixed(1));
            surplus = +(surplus - cut).toFixed(2);
          }
        }
      } else {
        for (let i = 0; i < mid.length && surplus < -0.01; i++) {
          const add = Math.min(
            +((-surplus) / (mid.length - i)).toFixed(2),
            +(0.8 - mid[i].duration).toFixed(2)
          );
          if (add > 0.01) {
            mid[i].duration = Math.min(0.8, +(mid[i].duration + add).toFixed(1));
            surplus = +(surplus + add).toFixed(2);
          }
        }
      }
    }
  })();

  renderTLRows();
  const nNote      = nIds.length       ? ` + 생성 포즈 ${nIds.length}종`      : '';
  const reqNote    = reqPoses.length   ? ` · 필수 포즈 ${reqPoses.length}개`   : '';
  const phraseNote = reqPhrases.length ? ` · 필수 동작 ${reqPhrases.length}개` : '';
  statusEl.textContent = `✓ ${tlRows.length}개 블록 생성 완료${nNote}${reqNote}${phraseNote}. 수정 후 적용하세요.`;
  _setApplyBtnActive(true);
};

// ════════════════════════════════════════════════════════════
//  JSON 가져오기 모달
// ════════════════════════════════════════════════════════════
window.showImportModal = function() {
  document.getElementById('import-textarea').value = '';
  document.getElementById('import-err').textContent = '';
  document.getElementById('import-modal-bg').classList.add('open');
  setTimeout(() => document.getElementById('import-textarea').focus(), 60);
};

window.hideImportModal = function() {
  document.getElementById('import-modal-bg').classList.remove('open');
};

// ESC 키로 닫기
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') hideImportModal();
});
// 배경 클릭으로 닫기
document.getElementById('import-modal-bg').addEventListener('click', e => {
  if (e.target === document.getElementById('import-modal-bg')) hideImportModal();
});

window.confirmImport = function() {
  const errEl = document.getElementById('import-err');
  const text  = document.getElementById('import-textarea').value.trim();
  errEl.textContent = '';

  if (!text) { errEl.textContent = '⚠ JSON을 입력하세요.'; return; }

  let data;
  try { data = JSON.parse(text); }
  catch(e) { errEl.textContent = '⚠ JSON 파싱 오류: ' + e.message; return; }

  if (!Array.isArray(data) || !data.length) {
    errEl.textContent = '⚠ 배열 형식이 필요합니다: [ ... ]';
    return;
  }

  // 지원 형식 감지 및 변환
  let rows;
  try {
    // 형식 1: [{pose_id, duration}]  형식 2: [{time, pose_id}]  형식 3: ["P-001", ...]
    const isKF      = data[0].time !== undefined && data[0].pose_id;
    const isDirect  = data[0].pose_id !== undefined && data[0].time === undefined;
    const isStrings = typeof data[0] === 'string';

    if (isKF) {
      // 키프레임 형식 → duration 계산
      rows = data.map((kf, i) => {
        const next = data[i + 1];
        const dur  = next ? +(next.time - kf.time).toFixed(2) : 0.5;
        return { pose_id: kf.pose_id, duration: Math.max(0.1, dur) };
      });
    } else if (isDirect) {
      rows = data.map(d => ({
        pose_id:  d.pose_id,
        duration: d.duration ? +parseFloat(d.duration).toFixed(2) : 0.5,
      }));
    } else if (isStrings) {
      rows = data.map(id => ({ pose_id: id, duration: 0.5 }));
    } else {
      errEl.textContent = '⚠ 지원하지 않는 형식입니다.';
      return;
    }
  } catch(e) {
    errEl.textContent = '⚠ 데이터 변환 오류: ' + e.message;
    return;
  }

  // pose_id 존재 여부 검증
  const unknown = rows.filter(r => !POSE_DB[r.pose_id]).map(r => r.pose_id);
  if (unknown.length) {
    errEl.textContent = `⚠ 존재하지 않는 포즈: ${unknown.slice(0,5).join(', ')}${unknown.length > 5 ? ' 외 ' + (unknown.length - 5) + '개' : ''}`;
    return;
  }

  // duration 이상값 클램프
  rows = rows.map(r => ({ ...r, duration: Math.min(30, Math.max(0.1, r.duration)) }));

  tlRows = rows;
  renderTLRows();
  hideImportModal();
  switchTab('timeline');
  setStatus(`✓ JSON 가져오기 완료 — ${rows.length}개 포즈`);
  document.getElementById('gen-status').textContent =
    `✓ JSON으로 ${rows.length}개 포즈 불러옴. 수정 후 적용하세요.`;
};

window.exportJSON = function() {
  const kfs = tlRows.length ? tlRowsToKFs() : allKeyframes;
  if (!kfs.length) { alert('시퀀스가 비어 있습니다.'); return; }
  const a = document.createElement('a');
  a.href = 'data:application/json,' + encodeURIComponent(JSON.stringify(kfs, null, 2));
  a.download = 'timeline.json';
  a.click();
};

window.exportYAML = function() {
  if (!allKeyframes.length) { alert('재생 목록이 비어 있습니다. 먼저 JSON 타임라인을 적용하세요.'); return; }

  const jointNames = [
    'openarmx_left_joint1','openarmx_left_joint2','openarmx_left_joint3','openarmx_left_joint4',
    'openarmx_left_joint5','openarmx_left_joint6','openarmx_left_joint7',
    'openarmx_right_joint1','openarmx_right_joint2','openarmx_right_joint3','openarmx_right_joint4',
    'openarmx_right_joint5','openarmx_right_joint6','openarmx_right_joint7'
  ];
  const shortKeys = ['L1','L2','L3','L4','L5','L6','L7','R1','R2','R3','R4','R5','R6','R7'];

  let yaml = 'joint_names:\n';
  jointNames.forEach(n => { yaml += `- ${n}\n`; });
  yaml += 'points:\n';

  allKeyframes.forEach(kf => {
    const angles = POSE_DB[kf.pose_id];
    if (!angles) return;
    yaml += '- positions:\n';
    shortKeys.forEach(k => {
      yaml += `  - ${angles[k] !== undefined ? angles[k] : 0}\n`;
    });
    yaml += `  time_from_start: ${kf.time}\n`;
  });

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
  const a = document.createElement('a');
  a.href = 'data:text/yaml;charset=utf-8,' + encodeURIComponent(yaml);
  a.download = `timeline_${ts}.yaml`;
  a.click();
};

// ════════════════════════════════════════════════════════════
//  UI 렌더링
// ════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────
//  모듈 조합 패널
// ────────────────────────────────────────────────────────────
function _modRange(f) {
  if (f === 1) return [1, 3];
  if (f === 2) return [4, 6];
  if (f === 3) return [7, 10];
  return [1, 10];
}

window.setModFilter = function(side, f) {
  if (side === 'L') { lModFilter = f; renderModList('L'); }
  else              { rModFilter = f; renderModList('R'); }
  const wrap = document.getElementById(side === 'L' ? 'l-filter' : 'r-filter');
  wrap.querySelectorAll('.mod-filter-btn').forEach((b, i) => b.classList.toggle('on', i === f));
};

function renderModList(side) {
  // 좌우 모두 동일한 CANON_MODULE_DB를 표시 — 적용 시에만 방향 변환
  const f   = side === 'L' ? lModFilter : rModFilter;
  const sel = side === 'L' ? selectedLModule : selectedRModule;
  const [mn, mx] = _modRange(f);
  const listEl = document.getElementById(side === 'L' ? 'l-mod-list' : 'r-mod-list');
  listEl.innerHTML = '';
  Object.entries(CANON_MODULE_DB).forEach(([id, mod]) => {
    if (mod.activity < mn || mod.activity > mx) return;
    const card = document.createElement('div');
    card.className = 'mod-card' + (id === sel ? ' selected' : '');
    card.id = `mc-${side}-${id}`;
    const bw = Math.round(mod.activity * 12);
    // source 레이블: 최초 출처 2개만 표시 (ⓛ=left 원본, ⓡ=right 반전)
    const srcLabel = mod.sources.slice(0,2)
      .map(s => s.replace(':L','ⓛ').replace(':R','ⓡ')).join(' ');
    card.innerHTML =
      `<span class="mod-id">${id}</span>` +
      `<span class="mod-src">${srcLabel}</span>` +
      `<span class="mod-act-bar" style="width:${bw}px"></span>` +
      `<span class="mod-act-num">${mod.activity}</span>`;
    card.onclick = () => {
      listEl.querySelectorAll('.mod-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      if (side === 'L') selectedLModule = id;
      else              selectedRModule = id;
      lastFocusedSide = side;

      // P-001 중립 기준으로 재구성 후 canonical 변환 적용
      const _neutral = POSE_DB['P-001'] || {};
      Object.assign(q, _neutral);
      if (selectedLModule && CANON_MODULE_DB[selectedLModule])
        Object.assign(q, _canonToLeft(CANON_MODULE_DB[selectedLModule].J));
      if (selectedRModule && CANON_MODULE_DB[selectedRModule])
        Object.assign(q, _canonToRight(CANON_MODULE_DB[selectedRModule].J));
      updateFK(q);

      document.getElementById('cur-pose-id').textContent =
        'L:' + (selectedLModule||'?') + ' R:' + (selectedRModule||'?');
      const dir = side === 'L' ? '왼팔(canonical)' : '오른팔(mirror)';
      setStatus(`${dir} ${id} 적용됨`);
      _updateCompPanel();
      _runRealtimeCheck();
    };
    listEl.appendChild(card);
  });
}

function _updateCompPanel() {
  const lM = selectedLModule ? CANON_MODULE_DB[selectedLModule] : null;
  const rM = selectedRModule ? CANON_MODULE_DB[selectedRModule] : null;
  const lEl = document.getElementById('comp-l-val');
  const rEl = document.getElementById('comp-r-val');
  if (lEl) lEl.textContent = lM ? `L:${selectedLModule}  (${lM.sources[0]}, lv.${lM.activity})` : '—';
  if (rEl) rEl.textContent = rM ? `R:${selectedRModule}  (${rM.sources[0]}, lv.${rM.activity})` : '—';
}

function renderModulePanel() {
  renderModList('L');
  renderModList('R');
  _updateCompPanel();
}

// 방향키 내비게이션 — 모듈 탭이 활성일 때만 동작
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const modTab = document.getElementById('tab-modules');
  if (!modTab || !modTab.classList.contains('active')) return;
  if (!lastFocusedSide) return;
  e.preventDefault();

  const side   = lastFocusedSide;
  const listEl = document.getElementById(side === 'L' ? 'l-mod-list' : 'r-mod-list');
  const cards  = Array.from(listEl.querySelectorAll('.mod-card'));
  if (!cards.length) return;

  const selId  = side === 'L' ? selectedLModule : selectedRModule;
  const curIdx = selId ? cards.findIndex(c => c.id === `mc-${side}-${selId}`) : -1;

  const nextIdx = e.key === 'ArrowDown'
    ? Math.min(cards.length - 1, curIdx + 1)
    : Math.max(0, curIdx - 1);

  if (nextIdx !== curIdx) {
    cards[nextIdx].click();
    cards[nextIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

// ── 실시간 충돌 검사 ──
function _runRealtimeCheck() {
  const risks = _checkStatic(q);
  highlightLinks(risks);
  _showCollResult(risks, '실시간');
}

// 왼팔↔오른팔 각도 미러링
// POSE_DB 대칭 쌍(P-009↔P-010, P-011↔P-012 등)으로 확인된 규칙:
//   J4(팔꿈치)만 부호 유지, 나머지(J1·J2·J3·J5·J6·J7)는 부호 반전
function _mirrorAngles(a) {
  return {
    L1: -(a.R1||0),
    L2: -(a.R2||0),
    L3: -(a.R3||0),
    L4:  (a.R4||0),   // 팔꿈치: 부호 그대로
    L5: -(a.R5||0),
    L6: -(a.R6||0),
    L7: -(a.R7||0),
    R1: -(a.L1||0),
    R2: -(a.L2||0),
    R3: -(a.L3||0),
    R4:  (a.L4||0),   // 팔꿈치: 부호 그대로
    R5: -(a.L5||0),
    R6: -(a.L6||0),
    R7: -(a.L7||0),
  };
}

// N-포즈 번호 할당기
function _nextNId() {
  const nums = Object.keys(CUSTOM_POSE_META)
    .map(k => parseInt(k.replace('N-', ''))).filter(n => !isNaN(n));
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `N-${String(next).padStart(3, '0')}`;
}

// 대칭 모듈 ID 계산 — M-xxx 공통 네임스페이스이므로 단순 swap
// L:M-005 + R:M-012 의 대칭 = L:M-012 + R:M-005
function _symMods(lMod, rMod) {
  if (!lMod || !rMod) return null;
  if (lMod === rMod) return null; // 이미 대칭 (같은 모듈)
  return { lMod: rMod, rMod: lMod };
}

window.saveComposite = function() {
  if (!selectedLModule && !selectedRModule) {
    alert('왼팔 또는 오른팔 모듈을 먼저 선택하세요.');
    return;
  }

  // animate() 루프가 q를 매 프레임 덮어쓰기 때문에 q에서 직접 읽으면
  // 선택하지 않은 팔에 애니메이션 중간값이 섞일 수 있다.
  // → 선택된 모듈 DB 값을 우선 사용하고, 미선택 팔은 P-001 중립값으로 대체한다.
  const _saveLM = selectedLModule ? CANON_MODULE_DB[selectedLModule] : null;
  const _saveRM = selectedRModule ? CANON_MODULE_DB[selectedRModule] : null;
  const _saveNeutral = POSE_DB['P-001'] || {};
  // canonical → 실제 L/R 각도 변환
  const _lAngles = _saveLM ? _canonToLeft(_saveLM.J)  : null;
  const _rAngles = _saveRM ? _canonToRight(_saveRM.J) : null;
  const curAngles = {
    L1: _lAngles ? (_lAngles.L1||0) : (_saveNeutral.L1||0),
    L2: _lAngles ? (_lAngles.L2||0) : (_saveNeutral.L2||0),
    L3: _lAngles ? (_lAngles.L3||0) : (_saveNeutral.L3||0),
    L4: _lAngles ? (_lAngles.L4||0) : (_saveNeutral.L4||0),
    L5: _lAngles ? (_lAngles.L5||0) : (_saveNeutral.L5||0),
    L6: _lAngles ? (_lAngles.L6||0) : (_saveNeutral.L6||0),
    L7: _lAngles ? (_lAngles.L7||0) : (_saveNeutral.L7||0),
    R1: _rAngles ? (_rAngles.R1||0) : (_saveNeutral.R1||0),
    R2: _rAngles ? (_rAngles.R2||0) : (_saveNeutral.R2||0),
    R3: _rAngles ? (_rAngles.R3||0) : (_saveNeutral.R3||0),
    R4: _rAngles ? (_rAngles.R4||0) : (_saveNeutral.R4||0),
    R5: _rAngles ? (_rAngles.R5||0) : (_saveNeutral.R5||0),
    R6: _rAngles ? (_rAngles.R6||0) : (_saveNeutral.R6||0),
    R7: _rAngles ? (_rAngles.R7||0) : (_saveNeutral.R7||0),
  };

  if (editingNPoseId) {
    // ── 수정 모드 ──
    const id  = editingNPoseId;
    const sym = CUSTOM_POSE_META[id] && CUSTOM_POSE_META[id].mirrorId;

    POSE_DB[id] = curAngles;
    CUSTOM_POSE_META[id] = {
      lMod: selectedLModule, rMod: selectedRModule,
      mirrorId: sym || undefined,
    };

    // 대칭 포즈도 함께 업데이트
    if (sym && CUSTOM_POSE_META[sym]) {
      const symMods = _symMods(selectedLModule, selectedRModule);
      POSE_DB[sym] = _mirrorAngles(curAngles);
      CUSTOM_POSE_META[sym] = {
        lMod: symMods ? symMods.lMod : CUSTOM_POSE_META[sym].lMod,
        rMod: symMods ? symMods.rMod : CUSTOM_POSE_META[sym].rMod,
        mirrorId: id,
      };
    }

    editingNPoseId = null;
    document.getElementById('editing-indicator').textContent = '';
    renderCustomPoseList();
    // 수정이므로 select 재빌드 불필요 (ID 변경 없음)
    _updateReqPoseSelect();
    setStatus(sym ? `✓ ${id} + 대칭 ${sym} 수정됨` : `✓ ${id} 수정됨`);
    switchTab('custom');
    return;
  }

  // ── 신규 저장 ──
  const newId  = _nextNId();
  POSE_DB[newId]          = curAngles;

  // 대칭 쌍 생성 (양팔 모두 선택되었고 번호가 다를 때)
  const symMods = _symMods(selectedLModule, selectedRModule);
  let symId = null;
  if (symMods) {
    // newId 등록 후 바로 다음 번호 예약
    CUSTOM_POSE_META[newId] = { lMod: selectedLModule, rMod: selectedRModule }; // 임시
    symId = _nextNId();
    POSE_DB[symId]          = _mirrorAngles(curAngles);
    CUSTOM_POSE_META[symId] = { lMod: symMods.lMod, rMod: symMods.rMod, mirrorId: newId };
    POSE_IDS.push(symId);
  }
  // 원본에 mirrorId 반영
  CUSTOM_POSE_META[newId] = {
    lMod: selectedLModule, rMod: selectedRModule,
    mirrorId: symId || undefined,
  };
  POSE_IDS.push(newId);
  _invalidateTLCache(); // 옵션 캐시 무효화

  renderCustomPoseList();
  // 전체 재빌드 대신 새 옵션만 기존 select에 추가 (성능)
  [newId, symId].filter(Boolean).forEach(_appendPoseOptToSelects);
  _updateReqPoseSelect();
  const symNote = symId ? ` + 대칭 ${symId} 자동 생성` : '';
  setStatus(`✓ ${newId}${symNote}`);
  switchTab('custom');
  setTimeout(() => {
    const card = document.getElementById(`cc-${newId}`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50);
};

// ── 충돌 검사 ──

function _checkStatic(angles) {
  const risks = [];
  const L1=angles.L1||0, L2=angles.L2||0, L4=angles.L4||0;
  const R1=angles.R1||0, R2=angles.R2||0, R4=angles.R4||0;

  if (Math.abs(L1) > 1.5 && Math.abs(R1) > 1.5)
    risks.push({ level:'red',    links:['L1','R1'], msg:'양팔 어깨(J1) 고각 — 충돌 위험' });

  if (L4 > 1.5 && R4 > 1.5)
    risks.push({ level:'yellow', links:['L4','R4'], msg:'양팔 팔꿈치(J4) 상승 — 근접 경고' });

  if (Math.abs(L2) > 1.3 && Math.abs(R2) > 1.3)
    risks.push({ level:'yellow', links:['L2','R2'], msg:'양팔 어깨(J2) 고각 — 근접 경고' });

  const mag = ['L1','L2','L3','L4','R1','R2','R3','R4']
    .reduce((s, k) => s + Math.abs(angles[k]||0), 0);
  if (mag > 9.0 && !risks.length)
    risks.push({ level:'yellow', links:[], msg:'고강도 복합 포즈 — 주의 필요' });

  return risks;
}

function _checkTransition(angA, angB, frames = 15) {
  const hits = [];
  const KEYS = ['L1','L2','L3','L4','L5','L6','L7','R1','R2','R3','R4','R5','R6','R7'];
  for (let i = 0; i <= frames; i++) {
    const t = i / frames;
    const s = t * t * (3 - 2 * t);
    const mid = {};
    KEYS.forEach(k => { mid[k] = (angA[k]||0) + ((angB[k]||0) - (angA[k]||0)) * s; });
    const risks = _checkStatic(mid);
    if (risks.length) hits.push({ frame: i, pct: Math.round(t * 100), risks });
  }
  return hits;
}

window.runStaticCheck = function() {
  const risks = _checkStatic(q);
  highlightLinks(risks);
  _showCollResult(risks, '정적');
};

window.runTransitionCheck = function() {
  const resultEl = document.getElementById('coll-result');
  if (tlRows.length < 2) {
    if (resultEl) resultEl.textContent = '전환 검사: 타임라인에 포즈가 2개 이상 필요합니다.';
    return;
  }
  const allHits = [];
  for (let i = 0; i < tlRows.length - 1; i++) {
    const pA = poseToAngles(tlRows[i].pose_id);
    const pB = poseToAngles(tlRows[i + 1].pose_id);
    if (!pA || !pB) continue;
    const hits = _checkTransition(pA, pB, 15);
    if (hits.length) allHits.push({ from: tlRows[i].pose_id, to: tlRows[i+1].pose_id, hits });
  }
  _markTLCollision(allHits);
  if (!resultEl) return;
  if (!allHits.length) {
    resultEl.innerHTML = '<span style="color:#4f6">✓ 전환 구간 충돌 없음</span>';
    return;
  }
  resultEl.innerHTML = allHits.map(r => {
    const lvl = r.hits.some(h => h.risks.some(rk => rk.level === 'red')) ? 'red' : 'yellow';
    return `<div class="coll-item"><span class="coll-badge ${lvl}">${lvl==='red'?'위험':'경고'}</span>` +
           `<span style="color:#aab;font-size:10px;">&nbsp;${r.from}→${r.to}: ${r.hits.length}프레임 충돌</span></div>`;
  }).join('');
};

function _markTLCollision(allHits) {
  const danger = new Set(allHits
    .filter(r => r.hits.some(h => h.risks.some(rk => rk.level === 'red')))
    .map(r => `${r.from}|${r.to}`));
  const warn = new Set(allHits
    .filter(r => !danger.has(`${r.from}|${r.to}`))
    .map(r => `${r.from}|${r.to}`));
  document.querySelectorAll('.tl-row').forEach((row, i) => {
    row.classList.remove('coll-warn', 'coll-danger');
    if (i < tlRows.length - 1) {
      const key = `${tlRows[i].pose_id}|${tlRows[i+1].pose_id}`;
      if (danger.has(key)) row.classList.add('coll-danger');
      else if (warn.has(key)) row.classList.add('coll-warn');
    }
  });
}

function _showCollResult(risks, mode) {
  const el = document.getElementById('coll-result');
  if (!el) return;
  if (!risks.length) {
    el.innerHTML = `<span style="color:#4f6">✓ ${mode} 검사: 충돌 없음</span>`;
    return;
  }
  el.innerHTML = risks.map(r =>
    `<div class="coll-item"><span class="coll-badge ${r.level}">${r.level==='red'?'위험':'경고'}</span>` +
    `<span style="color:#aab;font-size:10px;">&nbsp;${r.msg}</span></div>`
  ).join('');
}

// ── 링크 하이라이트 ──

function _setLinkColor(linkName, hex, ei) {
  const g = groups[linkName];
  if (!g) return;
  g.traverse(obj => {
    if (obj.isMesh && obj.material) {
      obj.material.color.setHex(hex);
      obj.material.emissive.setHex(hex);
      obj.material.emissiveIntensity = ei;
    }
  });
}

function highlightLinks(risks) {
  clearHighlights();
  const red = new Set(), yellow = new Set();
  risks.forEach(r => r.links.forEach(lk => {
    if (r.level === 'red') red.add(lk);
    else if (!red.has(lk)) yellow.add(lk);
  }));
  red.forEach(lk    => _setLinkColor(lk, 0xff2200, 0.6));
  yellow.forEach(lk => _setLinkColor(lk, 0xffaa00, 0.45));
}

window.clearHighlights = function() {
  CHAIN.forEach(lk => {
    const n = lk.name;
    if (n === 'body' || n === 'L0' || n === 'R0') return;
    if (n.includes('tcp') || n.includes('_f') || n.includes('hand')) return;
    if (n.startsWith('L')) _setLinkColor(n, 0x1a4a9a, 0.08);
    else if (n.startsWith('R')) _setLinkColor(n, 0x9a2a1a, 0.08);
  });
  const el = document.getElementById('coll-result');
  if (el) el.textContent = '검사 결과가 여기 표시됩니다.';
};

// 포즈 목록 (기존 포즈 — N-series 제외)
function renderPoseList() {
  const area = document.getElementById('pose-list');
  area.innerHTML = '';
  const entries = Object.entries(POSE_DB).filter(([id]) => !id.startsWith('N-'));
  const h = document.createElement('div');
  h.className = 'sec';
  h.textContent = `포즈 데이터베이스 (${entries.length}개)`;
  area.appendChild(h);

  entries.forEach(([id, angles]) => {
    const div = document.createElement('div');
    div.className = 'pose-card';
    div.id = `pc-${id}`;
    const preview = ['L1','L2','L3','L4','R1','R2','R3','R4']
      .map(k => `${k}:${angles[k] >= 0 ? '+' : ''}${angles[k].toFixed(2)}`).join('  ');
    div.innerHTML = `
      <span class="pose-id">${id}</span>
      <span class="pose-vals">${preview}</span>
    `;
    div.onclick = () => {
      document.querySelectorAll('.pose-card').forEach(c => c.classList.remove('active'));
      div.classList.add('active');
      const ang = poseToAngles(id);
      Object.assign(q, ang);
      updateFK(ang);
      document.getElementById('cur-pose-id').textContent = id;
      setStatus(`포즈 ${id} 미리보기`);
    };
    area.appendChild(div);
  });
}

// 생성 포즈 목록
function renderCustomPoseList() {
  const area = document.getElementById('custom-list');
  area.innerHTML = '';
  const entries = Object.entries(CUSTOM_POSE_META);
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'sec';
    empty.style.color = '#8a8';
    empty.textContent = '생성된 포즈가 없습니다.';
    area.appendChild(empty);
    return;
  }
  const h = document.createElement('div');
  h.className = 'sec';
  h.textContent = `생성 포즈 (${entries.length}개)`;
  area.appendChild(h);

  entries.forEach(([id, meta]) => {
    const angles = POSE_DB[id];
    if (!angles) return;
    const card = document.createElement('div');
    card.className = 'custom-card';
    card.id = `cc-${id}`;
    const lLabel  = meta.lMod || '—';
    const rLabel  = meta.rMod || '—';
    const symBadge = meta.mirrorId
      ? `<span style="font-size:9px;color:#6f6;background:#0d1d0d;border:1px solid #2a5a2a;border-radius:3px;padding:1px 4px;margin-left:2px;">↔ ${meta.mirrorId}</span>`
      : '';
    card.innerHTML = `
      <span class="custom-card-id">${id}${symBadge}</span>
      <span class="custom-card-info">L:${lLabel} / R:${rLabel}</span>
      <div class="custom-card-btns">
        <button class="c-btn prev" onclick="previewPose('${id}')">미리</button>
        <button class="c-btn edit" onclick="editCustomPose('${id}')">수정</button>
        <button class="c-btn del"  onclick="deleteCustomPose('${id}')">삭제</button>
      </div>
    `;
    area.appendChild(card);
  });
}

window.deleteCustomPose = function(id) {
  const symId = CUSTOM_POSE_META[id] && CUSTOM_POSE_META[id].mirrorId;
  const msg   = symId ? `${id} + 대칭 ${symId}를 삭제하시겠습니까?` : `${id} 포즈를 삭제하시겠습니까?`;
  if (!confirm(msg)) return;

  [id, symId].filter(Boolean).forEach(pid => {
    delete POSE_DB[pid];
    delete CUSTOM_POSE_META[pid];
    const idx = POSE_IDS.indexOf(pid);
    if (idx !== -1) POSE_IDS.splice(idx, 1);
    reqPoses = reqPoses.filter(p => p !== pid);
    _removePoseOptFromSelects(pid); // 기존 select에서 해당 옵션만 제거
  });
  _invalidateTLCache();

  renderCustomPoseList();
  renderReqPoses();
  _updateReqPoseSelect();
  setStatus(symId ? `${id} + ${symId} 삭제됨` : `${id} 삭제됨`);
};

window.editCustomPose = function(id) {
  const meta = CUSTOM_POSE_META[id];
  if (!meta) return;
  editingNPoseId = id;
  // 해당 포즈 각도 로드
  const ang = POSE_DB[id];
  if (ang) { Object.assign(q, ang); updateFK(ang); }
  // 모듈 선택 복원
  selectedLModule = meta.lMod || null;
  selectedRModule = meta.rMod || null;
  renderModulePanel();
  if (selectedLModule) {
    const lCard = document.getElementById(`mc-L-${selectedLModule}`);
    if (lCard) { lCard.classList.add('selected'); lCard.scrollIntoView({ block:'nearest' }); }
  }
  if (selectedRModule) {
    const rCard = document.getElementById(`mc-R-${selectedRModule}`);
    if (rCard) { rCard.classList.add('selected'); rCard.scrollIntoView({ block:'nearest' }); }
  }
  _updateCompPanel();
  document.getElementById('editing-indicator').textContent = `✎ ${id} 수정 중`;
  setStatus(`${id} 수정 모드 — 모듈 변경 후 포즈 저장`);
  switchTab('modules');
};

// 필수 포즈 관련
function _updateReqPoseSelect() {
  const grpBase   = document.getElementById('req-optgroup-base');
  const grpCustom = document.getElementById('req-optgroup-custom');
  if (!grpBase || !grpCustom) return;
  const sel     = document.getElementById('req-pose-sel');
  const current = sel ? sel.value : '';

  grpBase.innerHTML   = '';
  grpCustom.innerHTML = '';

  POSE_IDS.filter(id => !id.startsWith('N-')).forEach(id => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = id;
    grpBase.appendChild(opt);
  });
  Object.keys(CUSTOM_POSE_META).forEach(id => {
    const opt = document.createElement('option');
    opt.value = opt.textContent = id;
    grpCustom.appendChild(opt);
  });

  // optgroup이 비면 label만 남아 UX가 어색하므로 숨김 처리
  grpBase.style.display   = grpBase.children.length   ? '' : 'none';
  grpCustom.style.display = grpCustom.children.length ? '' : 'none';

  if (sel && current) sel.value = current;
}

window.addReqPose = function() {
  const sel = document.getElementById('req-pose-sel');
  if (!sel || !sel.value) return;
  if (!reqPoses.includes(sel.value)) {
    reqPoses.push(sel.value);
    renderReqPoses();
  }
};

window.removeReqPose = function(idx) {
  reqPoses.splice(idx, 1);
  renderReqPoses();
};

function renderReqPoses() {
  const wrap = document.getElementById('req-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  reqPoses.forEach((pid, i) => {
    const chip = document.createElement('div');
    chip.className = 'req-chip';
    chip.innerHTML = `${pid}<button class="req-chip-rm" onclick="removeReqPose(${i})">✕</button>`;
    wrap.appendChild(chip);
  });
}

// ── 필수 동작 구 (reqPhrases) ────────────────────────────────
window.addReqPhrase = function() {
  const sel = document.getElementById('req-phrase-sel');
  if (!sel || !sel.value) return;
  if (!reqPhrases.includes(sel.value)) {
    reqPhrases.push(sel.value);
    renderReqPhraseChips();
  }
};

window.removeReqPhrase = function(idx) {
  reqPhrases.splice(idx, 1);
  renderReqPhraseChips();
};

function renderReqPhraseChips() {
  const wrap = document.getElementById('req-phrase-chips');
  if (!wrap) return;
  wrap.innerHTML = '';
  reqPhrases.forEach((phId, i) => {
    const ph = PHRASE_DB[phId];
    const totalDur = ph ? +(ph.poses.length * ph.dur).toFixed(1) : '?';
    const chip = document.createElement('div');
    chip.className = 'req-chip req-chip-phrase';
    chip.innerHTML = `🎬 ${ph ? ph.name : phId} <span style="opacity:.6;font-size:9px;">${totalDur}s</span><button class="req-chip-rm" onclick="removeReqPhrase(${i})">✕</button>`;
    wrap.appendChild(chip);
  });
}

// phrase select 옵션 채우기 (초기화 시 1회 실행)
(function _initPhraseSelect() {
  const sel = document.getElementById('req-phrase-sel');
  if (!sel) return;
  Object.entries(PHRASE_DB).forEach(([id, ph]) => {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = `${id} ${ph.name}`;
    sel.appendChild(opt);
  });
})();

// 타임라인 모드 전환
window.setTLMode = function(mode) {
  tlMode = mode;
  document.getElementById('mode-btn-time').classList.toggle('active', mode === 'time');
  document.getElementById('mode-btn-music').classList.toggle('active', mode === 'music');
  document.getElementById('tl-time-inputs').style.display  = mode === 'time'  ? 'flex' : 'none';
  document.getElementById('tl-music-inputs').style.display = mode === 'music' ? 'flex' : 'none';
};

function _applyMusicFile(file, onReady) {
  if (musicBlobUrl) URL.revokeObjectURL(musicBlobUrl);
  musicBlobUrl = URL.createObjectURL(file);
  bgAudio.src = musicBlobUrl;
  bgAudio.load();
  bgAudio.addEventListener('loadedmetadata', function handler() {
    bgAudio.removeEventListener('loadedmetadata', handler);
    musicDuration = Math.round(bgAudio.duration);
    if (onReady) onReady(file.name, musicDuration);
  });
}

window.handleMusicFile = function(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  _applyMusicFile(file, (name, dur) => {
    document.getElementById('gen-btn-music').style.display = 'block';
    document.getElementById('gen-status').textContent = `✓ ${name} 로드됨 — ${dur}초`;
    const plStatus = document.getElementById('pl-music-status');
    if (plStatus) { plStatus.textContent = `${name} (${dur}s)`; plStatus.style.color = '#6f6'; }
    _setApplyBtnActive(true);
  });
};

window.attachPlaylistMusic = function(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  _applyMusicFile(file, (name, dur) => {
    const plStatus = document.getElementById('pl-music-status');
    if (plStatus) { plStatus.textContent = `${name} (${dur}s)`; plStatus.style.color = '#6f6'; }
    setStatus(`✓ 음악 연결됨 — ${name}`);
    _setApplyBtnActive(true);
  });
};

window.detachMusic = function() {
  if (musicBlobUrl) { URL.revokeObjectURL(musicBlobUrl); musicBlobUrl = null; }
  bgAudio.removeAttribute('src');
  bgAudio.load();
  musicDuration = 0;
  const plStatus = document.getElementById('pl-music-status');
  if (plStatus) { plStatus.textContent = '없음'; plStatus.style.color = ''; }
  const genStatus = document.getElementById('gen-status');
  if (genStatus) genStatus.textContent = '';
  setStatus('음악 연결 해제됨');
};

// transition_id 칩
function renderTIDChips(tids) {
  const wrap = document.getElementById('tid-chips');
  wrap.innerHTML = '';
  tids.forEach(tid => {
    const chip = document.createElement('div');
    chip.className = 'tid-chip' + (tid === selectedTID ? ' on' : '');
    const cnt = allKeyframes.filter(k => k.transition_id === tid).length;
    chip.textContent = `ID: ${tid}  (${cnt}프레임)`;
    chip.onclick = () => {
      selectedTID = tid;
      _rebuildPlayTimeline();   // ← TID 변경 시 캐시 재빌드
      wrap.querySelectorAll('.tid-chip').forEach(c => c.classList.remove('on'));
      chip.classList.add('on');
      scrubber.max = _playDur;
      stopAnim();
      renderKFList();
      setStatus(`시퀀스 ${tid} 선택됨`);
    };
    wrap.appendChild(chip);
  });
}

// 키프레임 목록
function renderKFList() {
  _lastKFHighlight = -1; // 리스트 재빌드 시 하이라이트 초기화
  const area = document.getElementById('kf-list');
  area.innerHTML = '';
  const tl = activeTimeline();
  const d = totalDur();

  const sumEl = document.getElementById('tl-summary');
  sumEl.innerHTML = tl.length
    ? `<span>${tl.length}</span>개 키프레임 &nbsp;|&nbsp; 총 <span>${d.toFixed(1)}</span>s`
    : '키프레임 없음';

  tl.forEach((kf, i) => {
    const row = document.createElement('div');
    row.className = 'kf-row';
    row.id = `kf-row-${i}`;
    row.innerHTML = `
      <span class="kf-tid">${kf.transition_id}</span>
      <span class="kf-time">${kf.time.toFixed(2)}s</span>
      <span class="kf-pid">${kf.pose_id}</span>
      <button class="kf-preview" onclick="previewPose('${kf.pose_id}')">미리보기</button>
    `;
    area.appendChild(row);
  });
}

let _lastKFHighlight = -1;  // 마지막으로 하이라이트한 행 idx (같으면 스킵)
function highlightKFRow(t, tl) {
  if (!tl) tl = activeTimeline();
  if (!tl.length) return;
  let idx = 0;
  for (let i=0; i<tl.length; i++) { if (tl[i].time <= t) idx=i; else break; }
  if (idx === _lastKFHighlight) return; // 동일 행 → DOM 작업 스킵
  _lastKFHighlight = idx;
  document.querySelectorAll('.kf-row').forEach(r => r.classList.remove('current'));
  const row = document.getElementById(`kf-row-${idx}`);
  if (row) { row.classList.add('current'); row.scrollIntoView({block:'nearest', behavior:'instant'}); }
  // 비주얼 바 세그먼트 하이라이트 (재생 중 현재 포즈 표시)
  document.querySelectorAll('.tl-seg').forEach((s, j) => s.classList.toggle('seg-active', j === idx));
  // 편집 행 하이라이트 및 자동 스크롤
  const editRows = document.querySelectorAll('.tl-row');
  editRows.forEach((r, j) => r.classList.toggle('preview', j === idx));
  const activeRow = editRows[idx];
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

window.previewPose = function(id) {
  const ang = poseToAngles(id);
  if (!ang) return;
  Object.assign(q, ang);
  updateFK(ang);
  document.getElementById('cur-pose-id').textContent = id;

  document.querySelectorAll('.pose-card').forEach(c => c.classList.remove('active'));
  const pc = document.getElementById(`pc-${id}`);
  if (pc) pc.classList.add('active');
  setStatus(`포즈 ${id} 미리보기`);
};

// 탭 전환
window.switchTab = function(tab) {
  // playlist는 숨김 처리됐으므로 timeline으로 리다이렉트
  if (tab === 'playlist') tab = 'timeline';
  const tabs = ['poses','custom','timeline','modules'];
  document.querySelectorAll('.tab-btn').forEach((b,i) => b.classList.toggle('active', tabs[i]===tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id===`tab-${tab}`));
};

// 상태 텍스트
function setStatus(msg) { document.getElementById('status-lbl').textContent = msg; }

// ════════════════════════════════════════════════════════════
//  TCP 위치 표시
// ════════════════════════════════════════════════════════════
function updateTCP() {
  ['L_tcp','R_tcp'].forEach(n => {
    const wp = new THREE.Vector3();
    groups[n].getWorldPosition(wp);
    const x = wp.x.toFixed(3), y = (-wp.z).toFixed(3), z = wp.y.toFixed(3);
    document.getElementById(n==='L_tcp'?'tcp-l':'tcp-r').textContent = `(${x}, ${y}, ${z})`;
  });
}

// ════════════════════════════════════════════════════════════
//  메인 루프
// ════════════════════════════════════════════════════════════
function resizeRenderer() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight - 44;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  orbit.update();

  if (isPlaying) {
    // _playTimeline / _playDur 는 applyTimeline 시 1회 빌드 → 매 프레임 filter+sort 없음
    const tl = _playTimeline;
    const d  = _playDur;

    if (!tl.length || d <= 0) {
      // 타임라인이 비어있으면 재생 중지
      isPlaying = false;
      _syncPlayBtns();
    } else {
      try {
        let t = (performance.now() - startWall) / 1000;
        if (isLooping) {
          t = t % d;
        } else if (t >= d) {
          t = d;
          isPlaying = false;
          _syncPlayBtns();
          _audioPause();
        }
        pauseOffset = t;

        // ── 인터폴레이션 (캐시된 tl 전달 → 내부에서 activeTimeline() 호출 없음) ──
        const ang = interpolate(t, tl);

        // NaN/비유한 값 방어 (이전에 유한한 q 값으로 폴백)
        const safe = {};
        JOINT_KEYS.forEach(k => {
          safe[k] = isFinite(ang[k]) ? ang[k] : (isFinite(q[k]) ? q[k] : 0);
        });
        Object.assign(q, safe);
        updateFK(safe);

        scrubber.value = t;
        // 시간 레이블 — totalDur() 호출 없이 _playDur 사용
        document.getElementById('time-lbl').textContent = `${t.toFixed(2)} / ${d.toFixed(1)} s`;
        document.getElementById('cur-pose-id').textContent = nearestPoseId(t, tl);
        highlightKFRow(t, tl);
        _updateTLPlayhead(t, d);
      } catch(e) {
        console.error('[animate] 재생 오류:', e, '| 타임라인:', tl.length, '개, 현재 포즈:', nearestPoseId(pauseOffset, tl));
        isPlaying = false;
        _syncPlayBtns();
      }
    }
  }

  updateTCP();
  renderer.render(scene, camera);
}

window.addEventListener('resize', resizeRenderer);

// 초기화
renderPoseList();
renderCustomPoseList();
_updateReqPoseSelect();
renderModulePanel();
tlRows = [{ pose_id: 'P-001', duration: 0.5 }, { pose_id: 'P-002', duration: 0.5 }];
renderTLRows();
updateFK(q);
resizeRenderer();
animate();
_syncPlayBtns();
setStatus('메시 로딩 중...');

// 팔레트 외부 클릭 닫기
document.addEventListener('click', function(e) {
  const wrap = document.getElementById('color-picker-wrap');
  if (wrap && !wrap.contains(e.target)) document.getElementById('color-palette').classList.remove('open');
});

// ── 온보딩 가이드 ──────────────────────────────────────────
const GUIDE_STEPS = [
  {
    target: null,
    icon: '🤖',
    title: 'OpenArmX 시뮬레이터에 오신 것을 환영합니다!',
    desc: '처음 사용하시는 분을 위해\n주요 기능을 간단히 안내해 드릴게요.\n\n(언제든 건너뛰기 가능합니다)',
  },
  {
    target: () => document.querySelectorAll('.tab-btn')[0],
    icon: '📚',
    title: '① 기존 포즈',
    desc: '[기존 포즈] 탭에는 466개의 사전 정의된\n포즈 데이터베이스가 있습니다.\n카드를 클릭하면 3D 뷰어에서\n즉시 미리보기 할 수 있어요.',
  },
  {
    target: () => document.querySelectorAll('.tab-btn')[3],
    icon: '🦾',
    title: '② 모듈 조합',
    desc: '[모듈 조합] 탭에서 왼팔·오른팔 M-xxx 모듈을\n각각 선택해 새로운 포즈를 만들 수 있어요.\n저·중·고 필터로 활동량별 모듈을 고르고\n충돌 여부를 실시간으로 확인할 수 있어요.',
  },
  {
    target: () => document.querySelectorAll('.tab-btn')[1],
    icon: '✨',
    title: '③ 생성 포즈',
    desc: '모듈 조합 후 [포즈 저장]을 누르면\n[생성 포즈] 탭에 N-001부터 자동 저장됩니다.\n저장된 포즈는 수정·삭제가 가능하고\n타임라인 필수 포즈로도 활용할 수 있어요.',
  },
  {
    target: () => document.getElementById('gen-btn'),
    icon: '🎵',
    title: '④ AI 댄스 시퀀스 생성',
    desc: '[타임라인] 탭에서 시간 또는 음악 파일 기반으로\nAI 댄스 시퀀스를 자동 생성할 수 있어요.\n기존 포즈 466개 + 생성 포즈 전체가\n생성 풀에 자동 포함됩니다.',
  },
  {
    target: () => document.querySelector('.apply-btn[onclick*="applyTimeline"]'),
    icon: '▶',
    title: '⑤ 적용 & 재생',
    desc: '[✓ 적용 & 재생]을 누르면\n3D 뷰어에서 시퀀스가 바로 재생됩니다.\n음악 싱크 재생은 물론\nJSON · YAML 내보내기도 지원합니다.',
  },
  {
    target: () => document.getElementById('color-picker-toggle'),
    icon: '🎨',
    title: '⑥ 색상 & 스킨',
    desc: '[🎨] 버튼으로 배경 및 로봇 스킨을\n자유롭게 바꿀 수 있어요.\n왼팔·오른팔·몸통·손 색상을\n개별 또는 프리셋으로 설정할 수 있습니다.\n\n이제 직접 사용해 보세요! 🎉',
  },
];

let guideStep = 0;

function _guidePos(el, card) {
  if (!el) {
    card.style.top = '50%';
    card.style.left = '50%';
    card.style.transform = 'translate(-50%,-50%)';
    return;
  }
  card.style.transform = '';
  const r = el.getBoundingClientRect();
  const cw = 270, ch = card.offsetHeight || 180, pad = 12;
  let top = r.bottom + pad;
  let left = r.left;
  if (top + ch > window.innerHeight - pad) top = r.top - ch - pad;
  if (left + cw > window.innerWidth - pad) left = window.innerWidth - cw - pad;
  if (left < pad) left = pad;
  card.style.top  = top  + 'px';
  card.style.left = left + 'px';
}

function _guideHighlight(el, hl) {
  if (!el) { hl.style.display = 'none'; return; }
  hl.style.display = 'block';
  const r = el.getBoundingClientRect();
  const pad = 6;
  hl.style.top    = (r.top  - pad) + 'px';
  hl.style.left   = (r.left - pad) + 'px';
  hl.style.width  = (r.width  + pad * 2) + 'px';
  hl.style.height = (r.height + pad * 2) + 'px';
}

function _renderGuideStep(step) {
  const s = GUIDE_STEPS[step];
  const el = s.target ? s.target() : null;
  const overlay = document.getElementById('guide-overlay');
  const hl   = document.getElementById('guide-highlight');
  const card = document.getElementById('guide-card');

  // 타깃 없으면 오버레이 자체가 딤, 있으면 highlight box-shadow가 딤(타깃은 실제로 보임)
  overlay.style.background = el ? 'transparent' : 'rgba(0,0,12,0.82)';

  document.getElementById('guide-icon').textContent  = s.icon;
  document.getElementById('guide-title').textContent = s.title;
  document.getElementById('guide-desc').textContent  = s.desc;

  const dots = document.getElementById('guide-dots');
  dots.innerHTML = '';
  GUIDE_STEPS.forEach((_,i) => {
    const d = document.createElement('div');
    d.className = 'guide-dot' + (i === step ? ' on' : '');
    dots.appendChild(d);
  });

  const isLast = step === GUIDE_STEPS.length - 1;
  document.getElementById('guide-next').textContent = isLast ? '완료 ✓' : '다음 →';

  requestAnimationFrame(() => {
    _guideHighlight(el, hl);
    _guidePos(el, card);
  });

  if (step === 1) switchTab('poses');
  if (step === 2) switchTab('modules');
  if (step === 3) switchTab('custom');
  if (step === 4) switchTab('timeline');
  if (step === 6) switchTab('playlist');
}

function showGuide() {
  guideStep = 0;
  document.getElementById('guide-overlay').classList.add('active');
  _renderGuideStep(0);
}

window.nextGuideStep = function() {
  guideStep++;
  if (guideStep >= GUIDE_STEPS.length) { closeGuide(); return; }
  _renderGuideStep(guideStep);
};

window.closeGuide = function() {
  document.getElementById('guide-overlay').classList.remove('active');
  localStorage.setItem('oax_guide_shown', '1');
  switchTab('timeline');
};

// 첫 방문 시 자동 실행
if (!localStorage.getItem('oax_guide_shown')) {
  setTimeout(showGuide, 800);
}
