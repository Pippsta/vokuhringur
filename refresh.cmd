@echo off
setlocal

REM Run from the script's own folder so relative paths work.
cd /d "%~dp0"

echo === Vokuhringur refresh ===
echo.

echo [1/3] Regenerating observations.json...
python convert.py
if errorlevel 1 (
  echo.
  echo Conversion failed. Stopping.
  pause
  exit /b 1
)
echo.

echo [2/3] Checking git status...
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Not a git repo yet ^-^- observations.json updated locally but nothing to push.
  echo Run "git init" and connect to GitHub when you are ready to publish.
  echo.
  pause
  exit /b 0
)

git add observations.json friend_awake_times.xlsx eidurm_games.xlsx 2>nul
git diff --cached --quiet
if not errorlevel 1 (
  echo No changes to commit. Already up to date.
  echo.
  pause
  exit /b 0
)
echo.

echo [3/3] Committing and pushing...
git commit -m "data refresh"
if errorlevel 1 (
  echo Commit failed.
  pause
  exit /b 1
)
git push
if errorlevel 1 (
  echo Push failed. ^(Did you set the upstream remote?^)
  pause
  exit /b 1
)
echo.
echo Done. The page will update on the next Pages deploy.
pause
