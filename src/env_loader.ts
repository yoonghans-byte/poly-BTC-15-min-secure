/**
 * Decrypts .env.age using the age identity file and loads the
 * resulting key=value pairs into process.env.
 *
 * Falls back to plaintext .env if .env.age does not exist (dev mode).
 */
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

const AGE_BIN = process.env.AGE_BIN
  ?? path.join(
    process.env.LOCALAPPDATA ?? '',
    'Microsoft/WinGet/Packages/FiloSottile.age_Microsoft.Winget.Source_8wekyb3d8bbwe/age/age.exe',
  );

const AGE_KEY = process.env.AGE_KEY_FILE
  ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.age-key.txt');

const encryptedPath = path.resolve('.env.age');
const plaintextPath = path.resolve('.env');

if (fs.existsSync(encryptedPath)) {
  const decrypted = execFileSync(AGE_BIN, ['-d', '-i', AGE_KEY, encryptedPath], {
    encoding: 'utf-8',
    windowsHide: true,
  });
  dotenv.parse(decrypted);
  const parsed = dotenv.parse(decrypted);
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
} else if (fs.existsSync(plaintextPath)) {
  // Fallback for dev environments without age
  dotenv.config({ path: plaintextPath });
} else {
  throw new Error('No .env.age or .env file found — cannot load environment variables');
}
