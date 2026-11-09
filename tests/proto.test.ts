import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { downloadProto, getProtoTarget } from '../proto';

void test('selects the supported proto release archives', () => {
	assert.equal(getProtoTarget('win32', 'x64'), 'proto_cli-x86_64-pc-windows-msvc.zip');
	assert.equal(getProtoTarget('darwin', 'x64'), 'proto_cli-x86_64-apple-darwin.tar.xz');
	assert.equal(getProtoTarget('darwin', 'arm64'), 'proto_cli-aarch64-apple-darwin.tar.xz');
	assert.equal(getProtoTarget('linux', 'x64'), 'proto_cli-x86_64-unknown-linux-gnu.tar.xz');
	assert.equal(
		getProtoTarget('linux', 'arm64', true),
		'proto_cli-aarch64-unknown-linux-musl.tar.xz',
	);
	assert.throws(() => getProtoTarget('win32', 'arm64'), /Unsupported/);
	assert.throws(() => getProtoTarget('freebsd', 'x64'), /Unsupported/);
});

void test('authenticates metadata, archive and checksum requests and verifies bytes', async (ctx) => {
	const archive = Buffer.from('release archive');
	const digest = crypto.createHash('sha256').update(archive).digest('hex');
	const assetName = getProtoTarget('linux', 'x64');
	const urls: string[] = [];
	ctx.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
		urls.push(url);
		assert.equal((options.headers as Record<string, string>).Authorization, 'Bearer test-token');
		if (url.endsWith('/tags/v0.63.1')) {
			assert.equal(
				(options.headers as Record<string, string>).Accept,
				'application/vnd.github+json',
			);
			return Response.json({
				assets: [
					{ name: assetName, url: 'https://api.github.com/repos/moonrepo/proto/releases/assets/1' },
					{
						name: `${assetName}.sha256`,
						url: 'https://api.github.com/repos/moonrepo/proto/releases/assets/2',
					},
				],
			});
		}
		assert.equal((options.headers as Record<string, string>).Accept, 'application/octet-stream');
		return new Response(url.endsWith('/1') ? archive : `${digest}  ${assetName}\n`);
	});
	assert.deepEqual(await downloadProto('0.63.1', 'test-token', assetName), archive);
	assert.equal(urls.length, 3);
});

void test('rejects checksum mismatch and metadata URLs outside the GitHub API', async (ctx) => {
	const assetName = getProtoTarget('win32', 'x64');
	let assetUrl = 'https://api.github.com/repos/moonrepo/proto/releases/assets/1';
	ctx.mock.method(globalThis, 'fetch', async (url: string) => {
		if (url.endsWith('/latest')) {
			return Response.json({
				assets: [
					{ name: assetName, url: assetUrl },
					{
						name: `${assetName}.sha256`,
						url: 'https://api.github.com/repos/moonrepo/proto/releases/assets/2',
					},
				],
			});
		}
		return new Response(url.endsWith('/1') ? 'archive' : '0'.repeat(64));
	});
	await assert.rejects(downloadProto('latest', 'test-token', assetName), /checksum mismatch/);
	assetUrl = 'https://example.com/token-collector';
	await assert.rejects(downloadProto('latest', 'test-token', assetName), /Unexpected.*URL/);
});

void test('fails authenticated HTTP errors without falling back', async (ctx) => {
	let calls = 0;
	ctx.mock.method(globalThis, 'fetch', async () => {
		calls += 1;
		return new Response('', { status: 403 });
	});
	await assert.rejects(
		downloadProto('latest', 'test-token', getProtoTarget('darwin', 'arm64')),
		/HTTP 403/,
	);
	assert.equal(calls, 1);
});

void test('reports a missing release archive or checksum', async (ctx) => {
	ctx.mock.method(globalThis, 'fetch', async () => Response.json({ assets: [] }));
	await assert.rejects(
		downloadProto('latest', 'test-token', getProtoTarget('linux', 'x64')),
		/missing.*checksum/,
	);
});
