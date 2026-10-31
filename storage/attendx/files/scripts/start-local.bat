@echo off
echo ======================================================
echo           AttendX Local Offline Server Launcher
echo ======================================================
echo.

cd /d "%~dp0\.."

echo [1/3] Checking dependencies...
if not exist "node_modules" (
    echo Installing root dependencies...
    call npm install
)
if not exist "server\node_modules" (
    echo Installing server dependencies...
    cd server
    call npm install
    cd ..
)

echo [2/3] Starting AttendX Local Backend Server on port 3001...
start "AttendX Local Server" cmd /k "cd server && npm run start"

echo [3/3] Starting AttendX Web Application...
call npm run dev

pause
