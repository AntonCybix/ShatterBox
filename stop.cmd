@echo off
rem Stoppar ShatterBox (containrarna och talsyntesen). Samma som: shatterbox stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1" %*
if "%1"=="" pause
