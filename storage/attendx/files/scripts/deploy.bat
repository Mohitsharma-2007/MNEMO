@echo off
echo ======================================================
echo           AttendX Cloud & Git Deployment Tool
echo ======================================================
echo.

cd /d "%~dp0\.."

echo [1/3] Building production bundle...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed. Please fix errors before deploying.
    pause
    exit /b 1
)

echo.
echo [2/3] Deploying to Vercel...
echo If this is your first time, Vercel will ask you to login in your browser.
call npx vercel --prod

echo.
echo [3/3] GitHub Deployment Status:
git status -s

echo.
echo To push changes to your GitHub repository:
echo 1. git remote add origin https://github.com/YOUR_USERNAME/attendx.git (if not added yet)
echo 2. git push -u origin master
echo.

pause
