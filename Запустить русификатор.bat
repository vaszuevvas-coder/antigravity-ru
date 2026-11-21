@echo off
chcp 65001 >nul
title Русификатор Google Antigravity v2.0
cd /d "%~dp0"

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ==============================================================
    echo  Для запуска установщика требуется Node.js ^(версия 18 и выше^).
    echo ==============================================================
    where winget >nul 2>nul
    if %ERRORLEVEL% EQU 0 (
        choice /C YN /M "Установить Node.js LTS автоматически через winget прямо сейчас?"
        if not errorlevel 2 (
            winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
            set "PATH=%PATH%;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs"
        )
    )
)

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ОШИБКА] Node.js не найден. Скачайте и установите LTS-версию с https://nodejs.org/
    echo и затем снова запустите этот файл.
    pause
    exit /b 1
)

echo Запуск графического установщика русификатора Google Antigravity...
node "%~dp0src\cli.js" gui
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Произошла ошибка при запуске. Нажмите любую клавишу для выхода...
    pause >nul
)
