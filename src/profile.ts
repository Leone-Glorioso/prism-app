// The user's profile (display name and picture), kept in this browser and, with an account, synced.

import { emptyProfile, MAX_AVATAR_CHARS, sanitizeProfile } from './account';
import type { Profile } from './account';

const KEY = 'prism.profile';
const AVATAR_SIZE = 160;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export function loadProfile(): Profile {
  try { return sanitizeProfile(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { return emptyProfile(); }
}

export function saveProfile(p: Profile): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage blocked */ }
}

/** "Ada Lovelace" -> "AL"; falls back to the first letter of the email, then "G" for a guest. */
export function initials(name: string, email?: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (email?.[0] ?? 'G').toUpperCase();
}

/** Shows the picture, or the initials when there is none. The picture is a validated data URL, never free text. */
export function paintAvatar(el: HTMLElement, p: Profile, email?: string): void {
  if (p.avatar) {
    el.style.backgroundImage = `url("${p.avatar}")`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = initials(p.name, email);
  }
}

/** Cuts the centre square out of the image, shrinks it to 160 x 160 pixels and returns it as a small JPEG data URL. */
export async function imageToAvatar(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  if (file.size > MAX_FILE_BYTES) throw new Error('That image is larger than 10 MB.');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('This image could not be read.'); }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot resize images.');
    ctx.fillStyle = '#ffffff'; // JPEG has no transparency
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    if (!url.startsWith('data:image/jpeg;base64,') || url.length > MAX_AVATAR_CHARS) throw new Error('This image could not be reduced enough.');
    return url;
  } finally {
    bitmap.close();
  }
}
