@echo off
setlocal

REM Run from the script's own folder so relative paths work.
cd /d "%~dp0"

echo === Vokuhringur refresh ===
echo.

REM Pull the remote first if this is a git repo. The weekly action makes its
REM own commits to observations.json; pulling before the local update keeps
REM us from racing it on push.
git rev-parse --is-inside-work-tree >nul 2>&1
if not errorlevel 1 (
  echo [1/4] Pulling latest from GitHub...
  git pull --rebase --autostash
  if errorlevel 1 (
    echo.
    echo Pull failed. Resolve any conflicts manually, then re-run.
    pause
    exit /b 1
  )
  echo.
)

echo [2/4] Updating friend records in observations.json from awake_times.xlsx...
python update_friend_in_json.py
if errorlevel 1 (
  echo.
  echo Update failed. Stopping.
  pause
  exit /b 1
)
echo.

echo [3/4] Checking git status...
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo Not a git repo yet ^-^- observations.json updated locally but nothing to push.
  echo Run "git init" and connect to GitHub when you are ready to publish.
  echo.
  pause
  exit /b 0
)

git add observations.json 2>nul

REM Use should_commit.py for a substantive-content diff that ignores
REM the generated_at bump that update_friend_in_json wrote.
python should_commit.py
if not errorlevel 1 (
  echo No substantive changes - already up to date.
  REM Reset the working tree so the no-op generated_at bump doesn't linger.
  git checkout HEAD -- observations.json
  echo.
  pause
  exit /b 0
)
echo.

echo [4/4] Committing and pushing...
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
