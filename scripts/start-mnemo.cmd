@echo off
setlocal

set "PROJECT_ROOT=%~dp0.."
if exist "%PROJECT_ROOT%\.venv\Scripts\python.exe" (
  set "PYTHON=%PROJECT_ROOT%\.venv\Scripts\python.exe"
  set "PYTHON_ARGS="
) else (
  where python >nul 2>nul
  if not errorlevel 1 (
    set "PYTHON=python"
    set "PYTHON_ARGS="
  ) else (
    where py >nul 2>nul
    if not errorlevel 1 (
      set "PYTHON=py"
      set "PYTHON_ARGS=-3"
    ) else (
      echo Python was not found. Install Python 3.11+ or create .venv in the Mnemo directory.
      exit /b 1
    )
  )
)

pushd "%PROJECT_ROOT%"
"%PYTHON%" %PYTHON_ARGS% -m mnemo serve --host 127.0.0.1 --port 8000 %*
set "EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %EXIT_CODE%
