@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   chat4code-unrestricted - 前端启动器
echo ============================================

rem ---- 1. Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [1/4] 未找到 Node.js，尝试自动安装 ...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo       [错误] 未找到 Node.js 和 winget，请手动安装 Node.js 22.12+：https://nodejs.org/
    pause
    exit /b 1
  )
  call winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo       [错误] Node.js 自动安装失败，请手动安装：https://nodejs.org/
    pause
    exit /b 1
  )
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
) else (
  for /f "tokens=1 delims=v." %%v in ('node -v') do set "NODE_MAJOR=%%v"
  echo [1/4] Node.js 已安装（v!NODE_MAJOR!）
  if defined NODE_MAJOR if !NODE_MAJOR! LSS 22 echo       [提示] 建议升级到 Node.js 22.12+，当前是 v!NODE_MAJOR!
)

rem ---- 2. pnpm ----
where pnpm >nul 2>nul
if errorlevel 1 (
  echo [2/4] 未找到 pnpm，尝试自动安装 ...
  where corepack >nul 2>nul
  if not errorlevel 1 (
    call corepack enable pnpm >nul 2>nul
  )
  where pnpm >nul 2>nul
  if errorlevel 1 (
    echo       使用 npm 全局安装 pnpm ...
    call npm install -g pnpm
    if errorlevel 1 (
      echo       [错误] pnpm 安装失败，请手动执行：npm i -g pnpm
      pause
      exit /b 1
    )
    set "PATH=%APPDATA%\npm;%PATH%"
  )
) else (
  echo [2/4] pnpm 已安装
)

rem ---- 3. 依赖 ----
if not exist "node_modules" (
  echo [3/4] 安装前端依赖（首次运行，可能需要几分钟）...
  call pnpm install
  if errorlevel 1 (
    echo       [错误] 前端依赖安装失败
    pause
    exit /b 1
  )
) else (
  echo [3/4] 前端依赖已安装
)

rem ---- 4. 启动 ----
echo [4/4] 启动开发服务器 http://localhost:8090
start "" cmd /c "timeout /t 8 /nobreak >nul & start http://localhost:8090"
call pnpm dev
echo.
echo [退出] 开发服务器已停止
pause
