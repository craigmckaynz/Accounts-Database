@echo off
rem Starts McKay Accounts and opens it in the browser. Close this window to stop it.
cd /d "%~dp0app"
if not exist node_modules call npm install
if not exist dist call npm run build
start "" http://localhost:4310
node server\index.js
pause
