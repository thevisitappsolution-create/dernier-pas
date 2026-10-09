// Copie le jeu web dans store/www pour Capacitor (sans les dossiers de travail).
import { cpSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)), src = join(here, '..'), out = join(here, 'www');
const SKIP = new Set(['store', 'site', 'outils', 'supabase', '.git', 'README.md', 'GUIDE-PUBLICATION.md', 'node_modules']);
rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true });
for (const f of readdirSync(src)) if (!SKIP.has(f) && !f.startsWith('.')) cpSync(join(src, f), join(out, f), { recursive: true });
console.log('www prêt :', readdirSync(out).length, 'éléments');
