import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as core from '@actions/core';
import * as tc from '@actions/tool-cache';

interface Release {
	assets: { name: string; url: string }[];
}

const DOWNLOAD_TIMEOUT = 120_000;
const EXECUTABLE_MODE = 0o755;

export function getProtoTarget(platform: string, arch: string, musl = false) {
	if (platform === 'win32' && arch === 'x64') {
		return 'proto_cli-x86_64-pc-windows-msvc.zip';
	}

	const cpus: Record<string, string> = { arm64: 'aarch64', x64: 'x86_64' };
	const systems: Record<string, string> = {
		darwin: 'apple-darwin',
		linux: `unknown-linux-${musl ? 'musl' : 'gnu'}`,
	};
	const cpu = cpus[arch];
	const system = systems[platform];

	if (!cpu || !system) {
		throw new Error(`Unsupported proto platform: ${platform}/${arch}`);
	}

	return `proto_cli-${cpu}-${system}.tar.xz`;
}

async function request(url: string, token: string, accept: string) {
	// Fetch removes Authorization when following a redirect to another origin (release storage).
	const response = await fetch(url, {
		headers: { Accept: accept, Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT),
	});

	if (!response.ok) {
		throw new Error(`Proto download failed: HTTP ${response.status}`);
	}

	return response;
}

export async function downloadProto(version: string, token: string, assetName: string) {
	const releasePath = version === 'latest' ? 'latest' : `tags/v${version.replace(/^v/, '')}`;
	const response = await request(
		`https://api.github.com/repos/moonrepo/proto/releases/${releasePath}`,
		token,
		'application/vnd.github+json',
	);
	const release = (await response.json()) as Release;
	const asset = release.assets.find((entry) => entry.name === assetName);
	const checksum = release.assets.find((entry) => entry.name === `${assetName}.sha256`);

	if (!asset || !checksum) {
		throw new Error(`Proto release is missing ${assetName} or its SHA-256 checksum`);
	}

	// Only send the token to GitHub's API, never to a URL supplied by release metadata.
	for (const entry of [asset, checksum]) {
		if (
			!/^https:\/\/api\.github\.com\/repos\/moonrepo\/proto\/releases\/assets\/\d+$/.test(entry.url)
		) {
			throw new Error('Unexpected proto release asset URL');
		}
	}

	const archive = Buffer.from(
		await (await request(asset.url, token, 'application/octet-stream')).arrayBuffer(),
	);
	const expected = (await (await request(checksum.url, token, 'application/octet-stream')).text())
		.trim()
		.split(/\s+/)[0];
	const actual = crypto.createHash('sha256').update(archive).digest('hex');

	if (!/^[\da-f]{64}$/i.test(expected) || actual !== expected.toLowerCase()) {
		throw new Error(`Proto SHA-256 checksum mismatch for ${assetName}`);
	}

	return archive;
}

export async function installProto(version: string, token: string, binDir: string) {
	// Available in the action's Node.js 24 runtime; the ESLint compatibility table omits report.
	// eslint-disable-next-line node/no-unsupported-features/node-builtins
	const report = process.report?.getReport() as
		| { header?: { glibcVersionRuntime?: string } }
		| undefined;
	const target = getProtoTarget(
		process.platform,
		process.arch,
		!report?.header?.glibcVersionRuntime,
	);
	core.info(`Downloading proto ${version} via authenticated GitHub API (${target})`);
	const archive = await downloadProto(version, token, target);
	const tempRoot = path.join(path.dirname(binDir), 'temp');
	await fs.mkdir(tempRoot, { recursive: true });
	const temp = await fs.mkdtemp(path.join(tempRoot, 'authenticated-proto-'));

	try {
		const archivePath = path.join(temp, target);
		await fs.writeFile(archivePath, archive);
		const extracted = path.join(temp, 'extracted');
		await (target.endsWith('.zip')
			? tc.extractZip(archivePath, extracted)
			: tc.extractTar(archivePath, extracted, ['xJ', '--strip-components=1']));
		await fs.mkdir(binDir, { recursive: true });
		await Promise.all(
			['proto', 'proto-shim'].map(async (name) => {
				const filename = process.platform === 'win32' ? `${name}.exe` : name;
				await fs.copyFile(path.join(extracted, filename), path.join(binDir, filename));
				await fs.chmod(path.join(binDir, filename), EXECUTABLE_MODE);
			}),
		);
		core.info('Verified proto release SHA-256 checksum');
	} finally {
		await fs.rm(temp, { force: true, recursive: true });
	}
}
