import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import QRCode from 'qrcode';
import { DEFAULT_BASE_URL, filePath } from "../config.js";
import { loginWithQr } from "../ilink/login.js";
import { credentialsFile, ensureHome, loadCredentials, maskToken, saveCredentials } from "../store.js";
import { fail, info, ok, warn } from "../log.js";
function parseArgs(argv) {
    const args = {
        force: false,
        open: true,
        serve: true,
        port: 8787,
        baseUrl: DEFAULT_BASE_URL,
        deadlineMs: 6 * 60_000,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--force' || arg === '-f')
            args.force = true;
        else if (arg === '--no-open')
            args.open = false;
        else if (arg === '--no-serve')
            args.serve = false;
        else if (arg === '--port')
            args.port = Number(argv[++i] ?? 0) || args.port;
        else if (arg === '--base-url')
            args.baseUrl = argv[++i] ?? DEFAULT_BASE_URL;
        else if (arg === '--timeout')
            args.deadlineMs = Number(argv[++i] ?? 0) * 1000 || args.deadlineMs;
        else if (arg === '--help' || arg === '-h') {
            console.log('用法: mishu login [--force] [--no-open] [--no-serve] [--port 8787] [--timeout 秒]');
            process.exit(0);
        }
    }
    return args;
}
/** 二维码大约 2 分钟过期；这个常量只用于页面上显示倒计时 */
const QR_TTL_MS = 120_000;
function pageHtml(live) {
    const state = JSON.stringify({
        status: live.status,
        issuedAt: live.issuedAt,
        ttl: QR_TTL_MS,
        hasTicket: Boolean(live.png),
        accountId: live.creds?.accountId ?? null,
        error: live.error ?? null,
    });
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>秘书鱼 · 扫码登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.6 -apple-system, "PingFang SC", system-ui, sans-serif;
         background: #101215; color: #e8eaed; display: flex; justify-content: center; padding: 32px 16px; }
  .card { width: 100%; max-width: 520px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  p.sub { color: #9aa0a6; margin: 0 0 20px; font-size: 13px; }
  .qr { background: #fff; padding: 14px; border-radius: 14px; width: 100%; box-sizing: border-box; }
  .qr img { display: block; width: 100%; height: auto; image-rendering: pixelated; }
  .row { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; font-size: 13px; color: #9aa0a6; }
  .badge { padding: 3px 9px; border-radius: 999px; background: #1f2937; color: #d1d5db; font-size: 12px; }
  .bar { height: 4px; background: #1f2937; border-radius: 999px; overflow: hidden; margin-top: 10px; }
  .bar > i { display: block; height: 100%; width: 100%; background: #34d399; transition: width .5s linear; }
  .ok { color: #34d399; font-weight: 600; }
  ol { padding-left: 20px; color: #c7cbd1; font-size: 14px; }
  code { background: #1b1f24; padding: 2px 6px; border-radius: 6px; font-size: 12px; }
</style>
</head>
<body>
<div class="card">
  <h1>秘书鱼 · 扫码登录</h1>
  <p class="sub">二维码会自动刷新，你什么时候扫都行，不用赶时间。</p>
  <div class="qr"><img id="qr" alt="二维码" /></div>
  <div class="row">
    <span id="state" class="badge">连接中…</span>
    <span id="left">—</span>
  </div>
  <div class="bar"><i id="bar"></i></div>
  <ol>
    <li>手机微信 → 右上角「+」→ 扫一扫</li>
    <li>扫上面的码，在手机上点「确认」</li>
    <li>这一页会自动变成成功状态</li>
  </ol>
  <p class="sub" id="hint"></p>
</div>
<script>
const boot = ${state};
let live = boot;
const img = document.getElementById('qr');
const tag = document.getElementById('state');
const left = document.getElementById('left');
const bar = document.getElementById('bar');
const hint = document.getElementById('hint');
let lastIssued = 0;

function paint() {
  if (live.pngUrl && live.issuedAt !== lastIssued) {
    lastIssued = live.issuedAt;
    img.src = live.pngUrl + '?t=' + live.issuedAt;
  }
  if (live.status === 'confirmed') {
    tag.textContent = '✓ 登录成功';
    tag.className = 'badge ok';
    left.textContent = '';
    bar.style.width = '0%';
    hint.innerHTML = '机器人账号：<code>' + (live.accountId || '') + '</code>，可以关掉这一页了。';
    return;
  }
  const msLeft = Math.max(0, live.ttl - (Date.now() - live.issuedAt));
  const pct = Math.max(0, Math.min(100, (msLeft / live.ttl) * 100));
  bar.style.width = pct + '%';
  bar.style.background = pct > 30 ? '#34d399' : '#fbbf24';
  left.textContent = msLeft > 0 ? '还有 ' + Math.ceil(msLeft / 1000) + ' 秒' : '正在换新码…';
  tag.textContent = live.status === 'scaned' ? '已扫码，请在手机上确认'
    : live.status === 'wait' ? '等待扫码' : live.status;
  hint.textContent = live.error ? ('出错：' + live.error) : '';
}

async function tick() {
  try {
    const r = await fetch('/state', { cache: 'no-store' });
    const j = await r.json();
    live = { ...j, ttl: boot.ttl };
    live.pngUrl = '/qr.png';
    paint();
  } catch {}
  if (live.status !== 'confirmed') setTimeout(tick, 1000);
}
paint();
tick();
</script>
</body>
</html>`;
}
function startServer(live, port) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/qr.png') {
            if (!live.png) {
                res.writeHead(404).end('no qr yet');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
            res.end(live.png);
            return;
        }
        if (url.pathname === '/state') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({
                status: live.status,
                issuedAt: live.issuedAt,
                hasTicket: Boolean(live.png),
                accountId: live.creds?.accountId ?? null,
                error: live.error ?? null,
            }));
            return;
        }
        if (url.pathname === '/' || url.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(pageHtml(live));
            return;
        }
        res.writeHead(404).end('not found');
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            const addr = server.address();
            resolve({
                url: `http://127.0.0.1:${addr.port}`,
                close: () => server.close(),
            });
        });
    });
}
function appendLog(line) {
    try {
        ensureHome();
        fs.appendFileSync(filePath('mishu.log'), `${new Date().toISOString()} ${line}\n`);
    }
    catch {
        /* 日志失败不影响登录 */
    }
}
async function showQr(ticket, live, open) {
    ensureHome();
    const pngPath = filePath('qrcode.png');
    live.ticket = ticket;
    live.issuedAt = Date.now();
    live.png = await QRCode.toBuffer(ticket.qrcodeImgContent, { width: 720, margin: 2, errorCorrectionLevel: 'M' });
    fs.writeFileSync(pngPath, live.png);
    appendLog(`qr issued content=${ticket.qrcodeImgContent}`);
    console.log('');
    console.log(await QRCode.toString(ticket.qrcodeImgContent, { type: 'terminal', small: true }));
    console.log(`  二维码图片: ${pngPath}`);
    if (open && process.platform === 'darwin' && process.stdout.isTTY) {
        try {
            spawn('open', [pngPath], { stdio: 'ignore', detached: true }).unref();
        }
        catch {
            /* ignore */
        }
    }
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.force) {
        try {
            const existing = loadCredentials();
            if (existing) {
                info(`已经有机器人账号了：${existing.accountId}`);
                info(`凭据文件：${credentialsFile()}（token ${maskToken(existing.token)}）`);
                info('要重新扫码换一个账号，加 --force');
                return;
            }
        }
        catch (err) {
            warn(`${err.message}，继续重新登录`);
        }
    }
    const live = { issuedAt: Date.now(), status: 'init' };
    console.log('');
    console.log('  秘书鱼 · 微信机器人登录');
    console.log('  ─────────────────────────');
    console.log('  用微信扫码，并在手机上点「确认」。这动作就是创建机器人账号，');
    console.log('  不需要注册开发者，也不需要小号。');
    console.log('');
    let page;
    if (args.serve) {
        try {
            page = await startServer(live, args.port);
            console.log(`  ${'打开这个页面扫码（二维码会自动刷新）:'}`);
            console.log(`  ${page.url}`);
            console.log('');
            appendLog(`page served at ${page.url}`);
        }
        catch (err) {
            warn(`本地页面起不来（${err.message}），只能用终端里的二维码`);
        }
    }
    try {
        const creds = await loginWithQr({
            baseUrl: args.baseUrl,
            deadlineMs: args.deadlineMs,
            onQr: async (ticket) => {
                await showQr(ticket, live, args.open);
                live.status = 'wait';
                appendLog('status=wait');
                if (page)
                    info('页面上的二维码会自动刷新，扫完请在手机上点「确认」');
                else
                    info('等待扫码…（二维码约 2 分钟过期，过期会自动换一张）');
            },
            onStatus: (status) => {
                live.status = status;
                appendLog(`status=${status}`);
                if (status === 'scaned')
                    info('已扫码，等待手机确认…');
                if (status === 'confirmed')
                    info('手机已确认，正在保存凭据…');
            },
        });
        live.creds = creds;
        live.status = 'confirmed';
        saveCredentials(creds);
        console.log('');
        ok('登录成功，机器人账号已创建');
        console.log(`  机器人 ID : ${creds.accountId}`);
        console.log(`  授权微信  : ${creds.userId || '(未返回)'}`);
        console.log(`  业务地址  : ${creds.baseUrl}`);
        console.log(`  凭据文件  : ${credentialsFile()}（权限 0600）`);
        console.log('');
        console.log('  下一步：运行 `./bin/mishu echo`，然后在微信里给它发一条消息。');
        console.log('');
        try {
            fs.chmodSync(credentialsFile(), 0o600);
        }
        catch {
            /* ignore */
        }
    }
    catch (err) {
        live.error = err.message;
        appendLog(`login failed: ${live.error}`);
        fail(live.error);
        process.exitCode = 1;
    }
    finally {
        // 给页面留一点时间显示「登录成功」
        if (page)
            setTimeout(() => page.close(), live.creds ? 4000 : 800);
    }
}
main().catch((err) => {
    fail(err?.message ?? String(err));
    process.exitCode = 1;
});
