@echo off
title Saveclip
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install it from https://nodejs.org then run this file again. & pause & exit /b)
where yt-dlp >nul 2>nul || (echo yt-dlp is not installed. Open PowerShell and run: winget install yt-dlp & echo Then close this window and run start.bat again. & pause & exit /b)
if not exist node_modules call npm install
start "" cmd /c "ping 127.0.0.1 -n 4 >nul & start http://localhost:3000"
echo.
echo Saveclip is starting. Keep this window open while you use the site.
node server.js
pause
