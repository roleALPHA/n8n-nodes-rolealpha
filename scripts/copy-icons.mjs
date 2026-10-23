// Copies node icons next to the compiled node files (dist/nodes/**).
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const src = 'nodes';
const walk = (dir) =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});

for (const file of walk(src).filter((f) => f.endsWith('.svg') || f.endsWith('.png'))) {
	const target = join('dist', src, relative(src, file));
	mkdirSync(dirname(target), { recursive: true });
	cpSync(file, target);
}
