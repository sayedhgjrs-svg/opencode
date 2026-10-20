# Saveclip

Paste a TikTok, Instagram Reels or YouTube link and download the video without a watermark.
Node + Express backend that uses [yt-dlp](https://github.com/yt-dlp/yt-dlp); vanilla HTML/CSS/JS frontend.

## Run locally
1. Install Node 18+ and yt-dlp (`pip install -U yt-dlp` or `brew install yt-dlp`).
2. `npm install`
3. `npm start`, then open http://localhost:3000

Set `YTDLP_PATH` if yt-dlp is not on your PATH, and `PORT` to change the port.

## Ads
Search `AD SLOT` in `public/index.html`: top banner, left and right sidebars, bottom banner,
plus an optional in-content rectangle. Paste your network's global script at `AD NETWORK SCRIPT`.

## Notes
- Keep yt-dlp updated (`yt-dlp -U`); platforms change often and old versions break.
- Video downloads merge separate video and audio streams with ffmpeg (up to 1080p). ffmpeg must be on PATH; winget installs it with yt-dlp.
- Instagram and some TikTok videos may need cookies (`--cookies cookies.txt`) for age-restricted or login-gated content.
- Run behind HTTPS, keep the built-in rate limit, and add a CAPTCHA if you open this to the public.
- Downloading may breach the platforms' terms and creators' copyright. Add a terms page and a takedown contact before launching.
