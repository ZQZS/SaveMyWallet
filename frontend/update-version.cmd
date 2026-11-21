@echo off
setlocal
node "%~dp0scripts\update-version.mjs"
exit /b %errorlevel%
