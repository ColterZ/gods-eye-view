@echo off
REM Launch God's Eye View (Meteor Intelligence) self-healing supervisor in the background
cd /d "%~dp0"
start "GEV-Meteor-Supervisor" /min node scripts\start-meteor-dev.mjs
timeout /t 4 >nul
if exist LIVE-TUNNEL-URL.txt (
  type LIVE-TUNNEL-URL.txt
) else (
  echo Starting Vite on http://localhost:4173 ...
)
