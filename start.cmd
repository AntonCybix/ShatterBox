@echo off
rem Startar ShatterBox: Ollama, Docker, talsyntes och Discord-botar. Samma som: shatterbox start
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if "%1"=="" pause
