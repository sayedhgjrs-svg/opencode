/**
 * Saveclip backend: Express + yt-dlp
 *   POST /api/info      -> video metadata (title, thumbnail, duration...)
 *   GET  /api/download  -> streams the file to the browser
 * Requires: Node 18+ and yt-dlp on PATH (or set YTDLP_PATH).
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

app.set('trust proxy', 1); // correct client IPs behind Nginx / Render / Railway
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Basic abuse protection: 20 API calls per minute per IP. Tune as needed.
app.use('/api/', rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a minute and try again.' } }));

// Only accept links from supported platforms (also prevents the server being used as an open proxy).
const ALLOWED_HOSTS = /^(?:[\w-]+\.)*(tiktok\.com|instagram\.com|youtube\.com|youtu\.be)$/i;
function parseUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!['http:', 'https:'].includes(u.protocol) || !ALLOWED_HOSTS.test(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
const platformOf = (u) => /tiktok/i.test(u) ? 'TikTok' : /instagram/i.test(u) ? 'Instagram' : 'YouTube';

// Turn raw yt-dlp errors into messages a person can act on.
function friendly(stderr = '', err = {}) {
  const s = stderr.toLowerCase();
  let msg = 'Could not read this link. Make sure it points to a single public video.';
  if (err.code === 'ENOENT') msg = 'The server cannot find yt-dlp. Restart your computer, or set YTDLP_PATH.';
  else if (err.killed) msg = 'The video source took too long to respond. Try again.';
  else if (s.includes('confirm you') && s.includes('bot')) msg = 'YouTube is asking for a bot check. Update yt-dlp or use browser cookies.';
  else if (s.includes('private') || s.includes('login') || s.includes('sign in')) msg = 'This video is private or needs a login, so it cannot be downloaded.';
  else if (s.includes('unavailable') || s.includes('not found') || s.includes('404')) msg = 'This video is unavailable. Check that the link is correct and the video is public.';
  else if (s.includes('429') || s.includes('too many requests')) msg = 'The platform is limiting requests right now. Try again in a few minutes.';
  // Technical detail (last stderr line) helps debugging. Remove this line before going public.
  const last = (stderr || err.message || '').trim().split('\n').filter(Boolean).pop() || '';
  return last ? `${msg} [${last.slice(0, 220)}]` : msg;
}

// Inline the thumbnail as a data URI: platform CDNs often block hotlinking, which would break previews.
async function inlineThumb(url) {
  if (!url || !url.startsWith('https://')) return url || null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return url;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 2_000_000) return url;
    return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch { return url; }
}

app.post('/api/info', (req, res) => {
  const url = parseUrl(req.body && req.body.url);
  if (!url) return res.status(400).json({ error: 'Paste a valid TikTok, Instagram or YouTube link.' });

  execFile(YTDLP, ['-J', '--no-playlist', '--no-warnings', '--', url],
    { timeout: 60_000, maxBuffer: 25 * 1024 * 1024 },
    async (err, stdout, stderr) => {
      if (err) { console.error('[yt-dlp failed]', err.code || '', err.killed ? '(timeout)' : '', '\n' + (stderr || err.message)); return res.status(422).json({ error: friendly(stderr, err) }); }
      try {
        const i = JSON.parse(stdout);
        const seen = new Map();
        for (const f of i.formats || []) {
          if (!f.vcodec || f.vcodec === 'none' || !f.width || !f.height) continue;
          const long = Math.max(f.width, f.height), short = Math.min(f.width, f.height);
          if (long <= 1920) seen.set(long, short);
        }
        const qualities = [...seen].sort((a, b) => b[0] - a[0]).slice(0, 4).map(([cap, short]) => ({ label: short + 'p', cap }));
        res.json({
          url,
          qualities,
          platform: platformOf(url),
          title: i.title || 'Untitled video',
          uploader: i.uploader || i.channel || '',
          duration: i.duration || null,
          width: i.width || null,
          height: i.height || null,
          thumbnail: await inlineThumb(i.thumbnail),
        });
      } catch { res.status(500).json({ error: 'Unexpected response from the video source.' }); }
    });
});

// Some sources (TikTok especially) serve H.265/AV1/VP9, which many players cannot open.
// If the downloaded file is not H.264, convert it with ffmpeg (ffprobe + ffmpeg must be on PATH).
function ensureH264(file, done) {
  execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file],
    (err, out) => {
      if (err || String(out).trim() === 'h264') return done(file); // already fine, or cannot check
      const fixed = file.replace(/\.[^.]+$/, '') + '-h264.mp4';
      execFile('ffmpeg', ['-y', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart', fixed],
        { timeout: 300_000 }, (e2) => done(e2 ? file : fixed));
    });
}

app.get('/api/download', (req, res) => {
  const url = parseUrl(req.query.url);
  if (!url) return res.status(400).json({ error: 'Invalid link.' });

  const audio = req.query.type === 'audio';
  // Keep letters from any language (Arabic, etc.) in the file name; add an ASCII fallback for old browsers.
  const name = String(req.query.title || 'video').replace(/[^\p{L}\p{N}\s._-]/gu, '').trim().slice(0, 80) || 'video';
  const ascii = name.replace(/[^\x20-\x7E]/g, '').trim() || 'video';
  const disposition = (ext) => `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}.${ext}`;
  const fail = (stderr) => { if (!res.headersSent) res.status(502).json({ error: friendly(stderr) }); };

  // ---------- Audio: stream straight through ----------
  if (audio) {
    const p = spawn(YTDLP, ['-f', 'ba[ext=m4a]/ba', '-o', '-', '-q', '--no-warnings', '--no-playlist', '--', url]);
    let sent = false, errText = '';
    p.stderr.on('data', (d) => { errText += d; });
    p.stdout.on('data', (chunk) => {
      if (!sent) {
        sent = true;
        res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Disposition': disposition('m4a'), 'Cache-Control': 'no-store' });
      }
      if (!res.write(chunk)) { p.stdout.pause(); res.once('drain', () => p.stdout.resume()); } // backpressure
    });
    p.on('close', () => { if (!sent) return fail(errText); res.end(); });
    res.on('close', () => { if (!res.writableFinished) p.kill('SIGKILL'); }); // user cancelled
    return;
  }

  // ---------- Video: YouTube serves video and audio separately, so download both and merge with ffmpeg ----------
  // Needs ffmpeg on PATH (installed with yt-dlp via winget). Up to 1080p. The watermark filter keeps TikTok clean.
  const cap = Math.min(1920, Math.max(144, parseInt(req.query.cap, 10) || 1920));
  const lim = `[height<=?${cap}][width<=?${cap}]`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saveclip-'));
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  const fmt = [
    `bv*${lim}[vcodec^=avc1][ext=mp4]+ba[ext=m4a]`,              // H.264 + AAC: plays on every device
    `bv*${lim}[ext=mp4]+ba[ext=m4a]`,                            // any codec, if H.264 does not exist
    `b${lim}[ext=mp4][format_note!*=?watermarked]`,              // single-file sources (TikTok, Instagram)
    `bv*${lim}+ba`,
    'b',
  ].join('/');
  const p = spawn(YTDLP, ['-f', fmt, '-S', 'vcodec:h264,res,acodec:m4a', '--merge-output-format', 'mp4', '-o', path.join(dir, 'video.%(ext)s'),
    '-q', '--no-warnings', '--no-playlist', '--', url]);
  let errText = '';
  p.stderr.on('data', (d) => { errText += d; });
  res.on('close', () => { if (!res.writableFinished) p.kill('SIGKILL'); }); // user cancelled
  p.on('close', (code) => {
    const file = fs.readdirSync(dir).find((f) => /^video\.[a-z0-9]+$/i.test(f)); // ignores leftover video.f137.mp4 parts
    if (code !== 0 || !file) {
      console.error('[yt-dlp download failed]\n' + errText);
      cleanup();
      return fail(errText);
    }
    ensureH264(path.join(dir, file), (full) => {
      if (res.destroyed) return cleanup(); // user left while converting
      const ext = path.extname(full).slice(1).toLowerCase();
      res.writeHead(200, {
        'Content-Type': ext === 'mp4' ? 'video/mp4' : 'video/' + ext,
        'Content-Length': fs.statSync(full).size,
        'Content-Disposition': disposition(ext),
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(full).pipe(res);
      res.on('close', cleanup); // delete the temp files once the browser has them
    });
  });
});

app.listen(PORT, () => console.log(`Saveclip running on http://localhost:${PORT}`));
