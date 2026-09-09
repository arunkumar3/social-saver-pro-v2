@echo off
REM Starts LM Studio's headless API and the ingest server.
REM LM Studio is optional in Phase 1 — ingest, media download, and
REM transcription all work without it.
start "" /B "%USERPROFILE%\.lmstudio\bin\lms.exe" server start
cd /d "%~dp0\.."
node src\server.js
