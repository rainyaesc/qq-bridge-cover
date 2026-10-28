@echo off
cd /d "%~dp0"
node login-server.mjs
if errorlevel 1 pause
