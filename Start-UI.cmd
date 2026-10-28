@echo off
cd /d "%~dp0"
node ui-server.mjs
if errorlevel 1 pause
