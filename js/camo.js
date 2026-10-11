// Камуфляж техники и зданий: узоры считаются в шейдере (render.js teamMaterial) по позиции в пространстве модели, перебейка текстур не нужна.
// Здесь только таблицы узоров / палитр и разбор настроек; GLSL-часть — CAMO_GLSL.
import * as THREE from 'three';

// узор -> номер режима шейдера (0 — командная раскраска как раньше); один выбор на технику и здания слота
export const CAMO_PATTERNS = { team: ['Командный цвет', 0], khaki: ['Хаки (однотонный)', 1], woodland: ['Лесной', 2], desert: ['Пустынный', 3], digital: ['Цифровой (пиксельный)', 4] };
// палитры по цвету: основной, пятно 1, пятно 2, тёмные крапины (sRGB); 'custom' — из одного своего цвета (customShades)
export const CAMO_PALETTES = {
  green: ['Зелёный', [0x56693a, 0x7a6a42, 0x34452b, 0x24261c]],
  sand: ['Песочный', [0xc2a878, 0xa88a5c, 0xd8c79a, 0x7d6a48]],
  brown: ['Коричневый', [0x6b4f33, 0x8a6a45, 0x4a3523, 0x2c2018]],
  gray: ['Серый', [0x8a8d90, 0x6b6f73, 0xa5a8ab, 0x3e4145]],
  white: ['Белый (зимний)', [0xe8edf0, 0xb9c4cc, 0x8d9aa5, 0x5c6670]],
  black: ['Чёрный', [0x2b2d30, 0x1c1d20, 0x3d4044, 0x0f1011]],
  red: ['Красный', [0x8a2f26, 0x6b231c, 0xa8473a, 0x3a1410]],
  blue: ['Синий', [0x3a5a86, 0x2b4468, 0x547aa8, 0x16243a]]
};
export const CAMO_DEFAULT_CUSTOM = '#5a6b3a';
const hsl = { h: 0, s: 0, l: 0 };
/** 4 оттенка (THREE.Color) из одного цвета '#rrggbb': основной, светлее, темнее, тёмные крапины. */
export function customShades(hex) {
  const c = new THREE.Color(hex), { h, s, l } = c.getHSL(hsl);
  const mk = (dh, ls, k = 1) => new THREE.Color().setHSL((h + dh + 1) % 1, s * k, Math.min(0.92, Math.max(0.04, l * ls)));
  return [c, mk(0.04, 1.3), mk(-0.03, 0.65), mk(0, 0.38, 0.9)];
}
const pick = a => a[Math.floor(Math.random() * a.length)];
/** Случайный узор + палитра; taken — уже занятые палитры (по возможности не повторять). */
export function camoRandom(taken = []) {
  const pals = Object.keys(CAMO_PALETTES), free = pals.filter(p => !taken.includes(p));
  return { pattern: pick(Object.keys(CAMO_PATTERNS).filter(k => k !== 'team')), pal: pick(free.length ? free : pals) };
}

/** Режим шейдера и 4 цвета (THREE.Color) по узору/палитре ('custom' — из одного цвета custom '#rrggbb'). */
export function camoLook(pattern, pal = 'green', custom = CAMO_DEFAULT_CUSTOM) {
  const mode = (CAMO_PATTERNS[pattern] || CAMO_PATTERNS.team)[1];
  if (pal !== 'custom' && !CAMO_PALETTES[pal]) pal = 'green';
  return { mode, cols: pal === 'custom' ? customShades(custom) : CAMO_PALETTES[pal][1].map(c => new THREE.Color(c)), pal };
}

// шум значения в 3D; fbm в 2 октавы. camoMode: 1 хаки, 2 лес, 3 пустыня (крупнее и мягче), 4 цифра (шум по квадратной сетке)
export const CAMO_GLSL = `
uniform float camoMode, camoScale;
uniform vec3 camoA, camoB, camoC, camoD;
varying vec3 vCamoPos;
float camoH(vec3 p) { p = 50.0 * fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float camoN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(camoH(i), camoH(i + vec3(1, 0, 0)), f.x), mix(camoH(i + vec3(0, 1, 0)), camoH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(camoH(i + vec3(0, 0, 1)), camoH(i + vec3(1, 0, 1)), f.x), mix(camoH(i + vec3(0, 1, 1)), camoH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float camoF(vec3 p) { return camoN(p) * 0.67 + camoN(p * 2.07 + 7.3) * 0.33; }
vec3 camoColor(vec3 p) {
  if (camoMode < 1.5) return camoA;
  vec3 q = p * camoScale;
  if (camoMode > 3.5) q = (floor(q * 5.0) + 0.5) / 5.0;                  // digital: pixel = 1/5 of the noise period
  if (camoMode > 2.5 && camoMode < 3.5) q *= 0.6;                        // desert: bigger blotches
  float f = camoF(q), g = camoN(q * 1.3 + 11.0), h = camoN(q * 2.3 + 29.0);
  if (camoMode > 2.5 && camoMode < 3.5)                                  // soft edges
    return mix(mix(camoA, camoB, smoothstep(0.42, 0.58, f)), camoC, smoothstep(0.52, 0.7, g) * 0.8);
  vec3 c = mix(camoA, camoB, step(0.52, f));
  c = mix(c, camoC, step(0.6, g));
  return mix(c, camoD, step(0.68, h));
}
`;
