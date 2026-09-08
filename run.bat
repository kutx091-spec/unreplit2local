@echo off
setlocal
cd /d %~dp0

REM Create .env from the template on first run
if not exist ".env" if exist ".env.example" (
  copy /Y ".env.example" ".env" >nul
  echo Created .env from .env.example. Review it and fill in any real values required by the project (keys, database URLs, etc.).
)

REM Load .env if it exists
if exist .env (
  for /f "tokens=* delims=" %%a in (.env) do (
    set %%a
  )
)

REM Install Node.js dependencies
if not exist node_modules (
  echo Installing Node dependencies...
  pnpm install --frozen-lockfile --silent
)

echo Starting app...
REM Start all services in parallel
echo Starting service 1: cd /d "artifacts\api-server" && set NODE_ENV=development && pnpm run build && pnpm run start
start "Service 1" cmd /c "cd /d "artifacts\api-server" && set NODE_ENV=development && pnpm run build && pnpm run start"
echo Starting service 2: pnpm --filter @workspace/mockup-sandbox run dev
start "Service 2" cmd /c "pnpm --filter @workspace/mockup-sandbox run dev"
echo Starting service 3: pnpm --filter @workspace/replit-to-local run dev
start "Service 3" cmd /c "pnpm --filter @workspace/replit-to-local run dev"

endlocal
