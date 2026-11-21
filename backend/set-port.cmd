@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy RemoteSigned -File "%~dp0scripts\server.ps1" -Action SetPort -Port "%~1"
exit /b %errorlevel%
