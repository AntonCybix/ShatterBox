@echo off
rem ShatterBox pa kommandoraden. Kor "shatterbox help" for alla kommandon.
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js hittades inte. Kor setup.cmd forst, eller installera Node.js fran https://nodejs.org
  exit /b 1
)
node "%~dp0cli\shatterbox.mjs" %*
