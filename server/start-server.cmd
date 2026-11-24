@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "runtime=%~dp0node.exe"
if not exist "%runtime%" set "runtime=node.exe"
"%runtime%" "%~dp0server.mjs" %*
exit /b %errorlevel%
